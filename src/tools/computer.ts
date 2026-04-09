import { execSync } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { toTOON, truncateAXI } from "../utils/toon.js";

const DISPLAY = process.env.DISPLAY || ":99";

/**
 * Computer-Use tools following the AI SDK cookbook pattern.
 * Interacts with a virtual X11 display using xdotool.
 */
export function createComputerTools() {
    return {
        computer_screenshot: tool({
            description: "Capture a screenshot of the virtual desktop. Returns base64 image data.",
            inputSchema: z.object({}),
            execute: async () => {
                const tmpPath = `/tmp/screenshot_${Date.now()}.png`;
                try {
                    execSync(`DISPLAY=${DISPLAY} scrot ${tmpPath}`);
                    const buffer = readFileSync(tmpPath);
                    const base64 = buffer.toString("base64");
                    execSync(`rm ${tmpPath}`);

                    const toon = toTOON({ format: "png", size: buffer.length, data: `[base64 ${base64.length} chars]` }, "screenshot");
                    return toon + "\nhelp[1]: Inspect the screenshot to find coordinates for `computer_action`.";
                } catch (err: any) {
                    return `error: failed to capture screenshot: ${err.message}`;
                }
            },
        }),

        computer_action: tool({
            description: "Perform a mouse or keyboard action on the virtual desktop.",
            inputSchema: z.object({
                action: z.enum(["mouse_move", "left_click", "right_click", "middle_click", "double_click", "key", "type", "scroll_up", "scroll_down"]),
                x: z.number().optional().describe("X coordinate for mouse actions"),
                y: z.number().optional().describe("Y coordinate for mouse actions"),
                text: z.string().optional().describe("Text to type or key to press (e.g. 'Enter', 'ctrl+c', 'Hello World')"),
            }),
            execute: async ({ action, x, y, text }) => {
                try {
                    let cmd = "";
                    switch (action) {
                        case "mouse_move":
                            cmd = `xdotool mousemove ${x} ${y}`;
                            break;
                        case "left_click":
                            cmd = `xdotool mousemove ${x} ${y} click 1`;
                            break;
                        case "right_click":
                            cmd = `xdotool mousemove ${x} ${y} click 3`;
                            break;
                        case "middle_click":
                            cmd = `xdotool mousemove ${x} ${y} click 2`;
                            break;
                        case "double_click":
                            cmd = `xdotool mousemove ${x} ${y} click --repeat 2 1`;
                            break;
                        case "key":
                            cmd = `xdotool key "${text}"`;
                            break;
                        case "type":
                            cmd = `xdotool type -- "${text}"`;
                            break;
                        case "scroll_up":
                            cmd = `xdotool click 4`;
                            break;
                        case "scroll_down":
                            cmd = `xdotool click 5`;
                            break;
                    }
                    execSync(`DISPLAY=${DISPLAY} ${cmd}`);
                    return `status: action \`${action}\` completed\nhelp[1]: Run \`computer_screenshot\` to see the result.`;
                } catch (err: any) {
                    return `error: action \`${action}\` failed: ${err.message}`;
                }
            },
        }),

        computer_wait: tool({
            description: "Wait for a short period for the UI to settle.",
            inputSchema: z.object({
                ms: z.number().default(500).describe("Milliseconds to wait"),
            }),
            execute: async ({ ms }) => {
                await new Promise(resolve => setTimeout(resolve, ms));
                return `status: waited ${ms}ms`;
            },
        }),
    };
}
