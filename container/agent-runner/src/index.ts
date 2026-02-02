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
 * Build the IPC instructions to embed in the prompt.
 * This tells Cursor how to use the IPC mechanism for sending messages and scheduling tasks.
 */
function buildIpcInstructions(ctx: { chatJid: string; groupFolder: string; isMain: boolean }): string {
  const { chatJid, groupFolder, isMain } = ctx;
  
  return `
## NanoClaw IPC System

You have access to a file-based IPC system for communicating with the host WhatsApp router.
Write JSON files to the appropriate directories to trigger actions.

### Send Message to WhatsApp
Write a JSON file to \`/workspace/ipc/messages/\` with this structure:
\`\`\`json
{
  "type": "message",
  "chatJid": "${chatJid}",
  "text": "Your message here",
  "groupFolder": "${groupFolder}",
  "timestamp": "ISO timestamp"
}
\`\`\`
Filename should be unique, e.g., \`{timestamp}-{random}.json\`

### Schedule a Task
Write a JSON file to \`/workspace/ipc/tasks/\` with this structure:
\`\`\`json
{
  "type": "schedule_task",
  "prompt": "What the agent should do when task runs",
  "schedule_type": "cron|interval|once",
  "schedule_value": "cron expression or milliseconds or ISO timestamp",
  "context_mode": "group|isolated",
  "groupFolder": "${groupFolder}",
  "chatJid": "${chatJid}",
  "timestamp": "ISO timestamp"
}
\`\`\`

### List Tasks
Read \`/workspace/ipc/current_tasks.json\` to see scheduled tasks.

### Pause/Resume/Cancel Task
Write to \`/workspace/ipc/tasks/\`:
\`\`\`json
{
  "type": "pause_task|resume_task|cancel_task",
  "taskId": "task-id-here",
  "timestamp": "ISO timestamp"
}
\`\`\`

${isMain ? `### Register New Group (Main Only)
Write to \`/workspace/ipc/tasks/\`:
\`\`\`json
{
  "type": "register_group",
  "jid": "WhatsApp JID",
  "name": "Display name",
  "folder": "folder-name",
  "trigger": "@TriggerWord",
  "timestamp": "ISO timestamp"
}
\`\`\`
Check \`/workspace/ipc/available_groups.json\` for available groups.` : ''}
`;
}

/**
 * Run Cursor CLI with the given prompt.
 */
async function runCursorAgent(input: ContainerInput): Promise<ContainerOutput> {
  const { prompt, sessionId, groupFolder, chatJid, isMain, isScheduledTask } = input;

  // Build the full prompt with IPC instructions
  const ipcInstructions = buildIpcInstructions({ chatJid, groupFolder, isMain });
  
  let fullPrompt = prompt;
  if (isScheduledTask) {
    fullPrompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use the IPC system to send messages if needed.]\n\n${prompt}`;
  }
  
  // Add IPC instructions as system context
  fullPrompt = `${ipcInstructions}\n\n---\n\n${fullPrompt}`;

  // Build Cursor CLI arguments
  const args: string[] = [
    '-p', fullPrompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions'
  ];

  // Resume session if provided
  if (sessionId) {
    args.push('--resume', sessionId);
  }

  log(`Running Cursor agent with ${args.length} args, session: ${sessionId || 'new'}`);

  return new Promise((resolve) => {
    const agent = spawn('agent', args, {
      cwd: '/workspace/group',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Cursor uses CURSOR_API_KEY for authentication
        // The env file should contain this
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
