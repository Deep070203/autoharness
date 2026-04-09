import { execSync } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";
import { toTOON, truncateAXI } from "../utils/toon.js";

const SESSION_NAME = "autoharness";

/**
 * Ensures the tmux session exists.
 */
function ensureSession() {
    try {
        execSync(`tmux has-session -t ${SESSION_NAME} 2>/dev/null`);
    } catch {
        execSync(`tmux new-session -d -s ${SESSION_NAME} -n main`);
        // Set some friendly defaults
        execSync(`tmux set-option -t ${SESSION_NAME} history-limit 5000`);
    }
}

export function createTerminalTools() {
    ensureSession();

    return {
        terminal_run: tool({
            description:
                "Send a command to the persistent terminal session. This is for " +
                "long-running processes, REPLs, or interactive sessions. Returns success status.",
            inputSchema: z.object({
                command: z.string().describe("The command to run, e.g. 'node', 'python', or 'npm start'"),
            }),
            execute: async ({ command }) => {
                ensureSession();
                try {
                    // Send keys and Enter
                    execSync(`tmux send-keys -t ${SESSION_NAME}:main "${command.replace(/"/g, '\\"')}" C-m`);
                    return `status: command sent to terminal\nhelp[1]: Run \`terminal_read\` to see the output.`;
                } catch (err: any) {
                    return `error: failed to send command: ${err.message}`;
                }
            },
        }),

        terminal_read: tool({
            description: "Read the current content of the terminal screen.",
            inputSchema: z.object({
                lines: z.number().default(24).describe("Number of lines to read from the end"),
            }),
            execute: async ({ lines }) => {
                ensureSession();
                try {
                    const output = execSync(`tmux capture-pane -pt ${SESSION_NAME}:main -S -${lines}`, { encoding: "utf-8" });
                    const toon = toTOON({ content: output.trim() || "(empty screen)" }, "terminal");
                    return truncateAXI(toon, 4000) + "\nhelp[1]: Run `terminal_send_keys` if you need to provide interactive input (e.g. Ctrl+C).";
                } catch (err: any) {
                    return `error: failed to read terminal: ${err.message}`;
                }
            },
        }),

        terminal_send_keys: tool({
            description: "Send special keys or raw input to the terminal (e.g. C-c for Ctrl+C, Enter).",
            inputSchema: z.object({
                keys: z.string().describe("The keys to send, e.g. 'C-c', 'Enter', 'q'"),
            }),
            execute: async ({ keys }) => {
                ensureSession();
                try {
                    execSync(`tmux send-keys -t ${SESSION_NAME}:main ${keys}`);
                    return `status: keys \`${keys}\` sent\nhelp[1]: Run \`terminal_read\` to see the state after keys.`;
                } catch (err: any) {
                    return `error: failed to send keys: ${err.message}`;
                }
            },
        }),
    };
}
