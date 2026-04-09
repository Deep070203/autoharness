/**
 * Browser automation tools using Stagehand (Browserbase).
 *
 * Stagehand provides AI-driven browser actions:
 *   - act()     — perform a single action (click, type, scroll) via natural language
 *   - extract() — extract structured data from a page using a Zod schema
 *   - observe() — list available actions on the current page
 *
 * These are wrapped as Vercel AI SDK tools so the meta-agent and the
 * agent harness can both use them.
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { tool } from "ai";
import { z } from "zod";
import { toTOON, truncateAXI } from "../utils/toon.js";

// ---------------------------------------------------------------------------
// Stagehand lifecycle
// ---------------------------------------------------------------------------

let _stagehand: Stagehand | null = null;

/**
 * Initialize and return a Stagehand instance.
 * Uses local Chromium in headless mode (suitable for Docker containers).
 * Reuses the existing instance if already initialized.
 */
export async function initStagehand(): Promise<Stagehand> {
    if (_stagehand) return _stagehand;

    _stagehand = new Stagehand({
        env: "LOCAL",
        verbose: 0,
        model: {
            modelName: "gemini-2.5-flash-preview-04-17",
            apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        },
        localBrowserLaunchOptions: {
            headless: true,
            chromiumSandbox: false,     // Required for running inside Docker as root
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
        },
    });
    await _stagehand.init();
    console.log("[Browser] Stagehand initialized (local headless Chromium)");
    return _stagehand;
}

/**
 * Close the Stagehand instance and clean up browser resources.
 */
export async function closeStagehand(): Promise<void> {
    if (_stagehand) {
        await _stagehand.close();
        _stagehand = null;
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Create browser automation tools for the AI SDK agent.
 * Pass the returned object into your tools spread.
 */
export function createBrowserTools(stagehand: Stagehand) {
    return {
        browser_navigate: tool({
            description:
                "Navigate the browser to a URL. Returns confirmation with the final URL.",
            inputSchema: z.object({
                url: z.string().url().describe("The URL to navigate to"),
            }),
            execute: async ({ url }: { url: string }) => {
                try {
                    const page = stagehand.context.pages()[0];
                    await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 30000 });
                    return `Navigated to ${page.url()}`;
                } catch (err: any) {
                    return `ERROR navigating to ${url}: ${err.message}`;
                }
            },
        }),

        browser_act: tool({
            description:
                "Perform a single browser action described in natural language. " +
                "Examples: 'click the login button', 'type hello into the search box', " +
                "'scroll down', 'select the second option'.",
            inputSchema: z.object({
                action: z.string().describe("Natural language description of the action to perform"),
            }),
            execute: async ({ action }: { action: string }) => {
                try {
                    const result = await stagehand.act(action);
                    return `Action completed: ${action}. Success: ${result.success}`;
                } catch (err: any) {
                    return `ERROR performing action '${action}': ${err.message}`;
                }
            },
        }),

        browser_extract: tool({
            description:
                "Extract structured data from the current page. Describe what data you need " +
                "in natural language. Returns the extracted content in TOON format.",
            inputSchema: z.object({
                instruction: z.string().describe(
                    "What to extract, e.g. 'the page title and all product names'"
                ),
            }),
            execute: async ({ instruction }: { instruction: string }) => {
                try {
                    const data = await stagehand.extract(instruction);
                    const toon = toTOON(data, "extraction");
                    return truncateAXI(toon, 4000) + "\nhelp[1]: Run `browser_act` to interact with extracted items.";
                } catch (err: any) {
                    return `ERROR extracting data: ${err.message}`;
                }
            },
        }),

        browser_observe: tool({
            description:
                "List the available actions on the current page. Returns a list of " +
                "clickable elements, inputs, etc. in TOON format.",
            inputSchema: z.object({
                instruction: z.string().default("").describe(
                    "Optional: focus on specific elements, e.g. 'navigation links'"
                ),
            }),
            execute: async ({ instruction }: { instruction: string }) => {
                try {
                    const actions = instruction
                        ? await stagehand.observe(instruction)
                        : await stagehand.observe();
                    const toon = toTOON(actions, "actions");
                    return truncateAXI(toon, 4000) + "\nhelp[1]: Run `browser_act` with an instruction from the list.";
                } catch (err: any) {
                    return `ERROR observing page: ${err.message}`;
                }
            },
        }),

        browser_get_page_text: tool({
            description:
                "Get the full text content of the current page. Optimized for agent consumption.",
            inputSchema: z.object({}),
            execute: async () => {
                try {
                    const data = await stagehand.extract();
                    const text = data.pageText || "(empty page)";
                    return truncateAXI(text, 2000) + "\nhelp[1]: Run `browser_observe` to see interactive elements.";
                } catch (err: any) {
                    return `ERROR getting page text: ${err.message}`;
                }
            },
        }),
    };
}
