/**
 * NanoClaw Agent Runner (Cursor Edition)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 * Uses Cursor CLI instead of Claude Agent SDK
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface CursorJsonOutput {
  type: string;
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  result?: string;
  session_id?: string;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Write IPC instructions to a file in the workspace for the agent to reference.
 */
function writeIpcInstructions(ctx: { chatJid: string; groupFolder: string; isMain: boolean }): void {
  const { chatJid, groupFolder, isMain } = ctx;
  
  const instructions = `# NanoClaw IPC System

Write JSON files to these directories to trigger actions:

## Send Message: /workspace/ipc/messages/{timestamp}.json
{"type":"message","chatJid":"${chatJid}","text":"your message","groupFolder":"${groupFolder}","timestamp":"ISO"}

## Schedule Task: /workspace/ipc/tasks/{timestamp}.json  
{"type":"schedule_task","prompt":"task description","schedule_type":"cron|interval|once","schedule_value":"expression","context_mode":"group|isolated","groupFolder":"${groupFolder}","chatJid":"${chatJid}","timestamp":"ISO"}

## List Tasks: Read /workspace/ipc/current_tasks.json

## Pause/Resume/Cancel: /workspace/ipc/tasks/{timestamp}.json
{"type":"pause_task|resume_task|cancel_task","taskId":"id","timestamp":"ISO"}
${isMain ? `
## Register Group (main only): /workspace/ipc/tasks/{timestamp}.json
{"type":"register_group","jid":"JID","name":"Name","folder":"folder","trigger":"@Trigger","timestamp":"ISO"}
Available groups: /workspace/ipc/available_groups.json` : ''}
`;
  
  fs.writeFileSync('/workspace/ipc/IPC_INSTRUCTIONS.md', instructions);
}

/**
 * Run Cursor CLI with the given prompt.
 */
async function runCursorAgent(input: ContainerInput): Promise<ContainerOutput> {
  const { prompt, sessionId, groupFolder, chatJid, isMain, isScheduledTask } = input;

  // Write IPC instructions to a file for the agent to reference
  writeIpcInstructions({ chatJid, groupFolder, isMain });
  
  let fullPrompt = prompt;
  if (isScheduledTask) {
    fullPrompt = `[SCHEDULED TASK] ${prompt}`;
  }
  
  // Add brief reference to IPC system (no newline to avoid spawn issues)
  fullPrompt = `[IPC: See /workspace/ipc/IPC_INSTRUCTIONS.md] ${fullPrompt}`;

  // Build Cursor CLI arguments
  const args: string[] = [
    '-p', fullPrompt,
    '--output-format', 'json',
    '--force',  // Auto-approve commands
    '--approve-mcps'  // Auto-approve MCP servers
  ];

  // Resume session if provided
  if (sessionId) {
    args.push('--resume', sessionId);
  }

  log(`Running Cursor agent with ${args.length} args, session: ${sessionId || 'new'}`);
  log(`Prompt length: ${fullPrompt.length} chars`);

  return new Promise((resolve) => {
    // Use bash to run cursor-agent to ensure proper tty handling
    const shellCmd = `cursor-agent ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;
    log(`Shell command: ${shellCmd.substring(0, 200)}...`);
    
    const agent = spawn('bash', ['-c', shellCmd], {
      cwd: '/workspace/group',
      stdio: ['ignore', 'pipe', 'pipe'],  // Don't pipe stdin - cursor-agent doesn't need it
      env: {
        ...process.env,
      }
    });

    let stdout = '';
    let stderr = '';

    agent.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    agent.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      // Log stderr lines for debugging
      chunk.trim().split('\n').forEach((line: string) => {
        if (line) log(`[cursor] ${line}`);
      });
    });

    agent.on('close', (code) => {
      log(`Cursor agent exited with code ${code}`);

      if (code !== 0) {
        resolve({
          status: 'error',
          result: null,
          error: `Cursor agent exited with code ${code}: ${stderr.slice(-500)}`
        });
        return;
      }

      try {
        // Parse Cursor's JSON output
        // Cursor outputs multiple JSON objects, we want the final result
        const lines = stdout.trim().split('\n');
        let result: string | null = null;
        let newSessionId: string | undefined;

        for (const line of lines) {
          try {
            const parsed: CursorJsonOutput = JSON.parse(line);
            
            if (parsed.type === 'result' && parsed.subtype === 'success') {
              result = parsed.result || null;
              newSessionId = parsed.session_id;
            }
          } catch {
            // Skip non-JSON lines
          }
        }

        if (result !== null) {
          log('Cursor agent completed successfully');
          resolve({
            status: 'success',
            result,
            newSessionId
          });
        } else {
          // No result found, might be an error
          resolve({
            status: 'error',
            result: null,
            error: 'No result in Cursor output'
          });
        }
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse Cursor output: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    });

    agent.on('error', (err) => {
      log(`Cursor agent spawn error: ${err.message}`);
      resolve({
        status: 'error',
        result: null,
        error: `Failed to spawn Cursor agent: ${err.message}`
      });
    });
  });
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for group: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  try {
    log('Starting Cursor agent...');
    const output = await runCursorAgent(input);
    writeOutput(output);
    
    if (output.status === 'error') {
      process.exit(1);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
