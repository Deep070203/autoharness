import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import fs from "node:fs";
import path from "node:path";

/**
 * Configuration for an MCP server.
 */
export interface MCPServerConfig {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
}

/**
 * Handle for a connected MCP client.
 */
export interface MCPClientHandle {
    name: string;
    client: any; // Awaited<ReturnType<typeof createMCPClient>>
    tools: Record<string, any>;
}

/**
 * Load MCP server configurations from a JSON file.
 * Defaults to mcp-servers.json in the project root.
 */
export function loadMCPConfig(configPath: string = "mcp-servers.json"): MCPServerConfig[] {
    const resolved = path.resolve(configPath);
    if (!fs.existsSync(resolved)) {
        console.log(`[MCP] No config found at ${resolved}`);
        return [];
    }
    try {
        const content = fs.readFileSync(resolved, "utf-8");
        return JSON.parse(content);
    } catch (err) {
        console.error(`[MCP] Error reading config: ${err}`);
        return [];
    }
}

/**
 * Connect to a list of MCP servers and discover their tools.
 */
export async function connectMCPServers(configs: MCPServerConfig[]): Promise<MCPClientHandle[]> {
    const handles: MCPClientHandle[] = [];

    for (const config of configs) {
        try {
            console.log(`[MCP] Connecting to ${config.name}...`);
            const client = await createMCPClient({
                transport: new Experimental_StdioMCPTransport({
                    command: config.command,
                    args: config.args,
                    env: config.env || process.env as Record<string, string>,
                }),
            });

            const tools = await client.tools();
            handles.push({
                name: config.name,
                client,
                tools,
            });
            console.log(`[MCP] Connected to ${config.name} (${Object.keys(tools).length} tools)`);
        } catch (err) {
            console.error(`[MCP] Failed to connect to server ${config.name}: ${err}`);
        }
    }

    return handles;
}

/**
 * Merge tools from multiple MCP servers into a single tools object.
 * Tools are prefixed with the server name to avoid name collisions.
 */
export function mergeMCPTools(handles: MCPClientHandle[]): Record<string, any> {
    const merged: Record<string, any> = {};
    for (const handle of handles) {
        for (const [toolName, tool] of Object.entries(handle.tools)) {
            // Use naming convention: servername_toolname
            const namespacedName = `${handle.name}_${toolName}`;
            merged[namespacedName] = tool;
        }
    }
    return merged;
}

/**
 * Cleanly close all MCP client connections.
 */
export async function closeMCPServers(handles: MCPClientHandle[]): Promise<void> {
    for (const handle of handles) {
        try {
            await handle.client.close();
        } catch (err) {
            console.error(`[MCP] Error closing client ${handle.name}: ${err}`);
        }
    }
}
