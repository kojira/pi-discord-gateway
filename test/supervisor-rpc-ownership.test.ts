import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { invokeAgent, shutdownResidentAgents } from '../src/agent/invoke.js';

// Protocol fixture, not an imitation of the native supervisor implementation:
// verifies Gateway leaves request files untouched until Pi consumes them.
for (const persistent of [false, true]) {
  it(`leaves supervisor ownership to parent Pi (persistent=${persistent})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'piscord-supervisor-owner-'));
    const original = { ...config };
    const bin = join(root, 'pi');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
const tempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
fs.writeFileSync(${JSON.stringify(join(root, 'root'))},tempRoot);
let buffer='';
process.stdin.on('data', chunk => {
 buffer += chunk;
 while(buffer.includes('\\n')) {
  const i=buffer.indexOf('\\n'); const c=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1);
  if(c.type==='get_state') {send({type:'response',id:c.id,command:c.type,success:true,data:{sessionId:'parent',pendingMessageCount:0}});continue;}
  send({type:'response',id:c.id,command:c.type,success:true});
  if(c.type!=='prompt')continue;
  const dir=path.join(tempRoot,'supervisor-channels','run');fs.mkdirSync(path.join(dir,'requests'),{recursive:true});
  const request=path.join(dir,'requests','ask.json');
  fs.writeFileSync(request,JSON.stringify({type:'subagent.supervisor.request',id:'ask',createdAt:Date.now(),reason:'need_decision',message:'internal-only',expectsReply:true,runId:'run',agent:'worker',childIndex:0,orchestratorSessionId:'parent'}));
  send({type:'message_start',message:{role:'user',content:c.message}});
  setTimeout(()=>{
   const untouched=fs.existsSync(request) && !fs.existsSync(path.join(dir,'replies','ask.json'));
   fs.writeFileSync(${JSON.stringify(join(root, 'untouched'))},String(untouched));
   fs.unlinkSync(request); // Pi owns consumption, not Gateway.
   send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'parent handled child'}],stopReason:'stop'}});
   send({type:'agent_end',messages:[]});send({type:'agent_settled'});
  },1200);
 }
});
process.stdin.on('end',()=>process.exit(0));
`,
    );
    chmodSync(bin, 0o755);
    Object.assign(config, {
      piBin: bin,
      piRpcPersistent: persistent,
      piModel: '',
      piThinking: '',
      piExtraFlags: '',
      sessionsDir: join(root, 'sessions'),
    });
    const obsoleteCallback = vi.fn();
    const onAssistantMessage = vi.fn();
    try {
      const options = {
        cwd: root,
        onAssistantMessage,
        onSupervisorRequest: obsoleteCallback,
        connectionDelivery: { onAssistantMessage, onSupervisorRequest: obsoleteCallback },
      };
      const result = await invokeAgent('channel', 'request', options);
      expect(result.ok).toBe(true);
      expect(result.text).toBe('parent handled child');
      expect(obsoleteCallback).not.toHaveBeenCalled();
      expect(readFileSync(join(root, 'untouched'), 'utf8')).toBe('true');
      expect(readFileSync(join(root, 'root'), 'utf8')).toContain('piscord-subagents-');
      expect(JSON.stringify(onAssistantMessage.mock.calls)).not.toContain('internal-only');
    } finally {
      await shutdownResidentAgents();
      Object.assign(config, original);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
