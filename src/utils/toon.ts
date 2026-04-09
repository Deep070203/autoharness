/**
 * TOON (Token-Optimized Object Notation)
 * Defined by AXI (axi.md) to save tokens and improve agent ergonomics.
 */

/**
 * Converts a JSON object or array to TOON format.
 * TOON omits braces, quotes, and commas where possible.
 * Format: key[count]{fields}: val1,val2 val3,val4
 */
export function toTOON(data: any, rootName?: string): string {
    if (data === null || data === undefined) return "null";

    // Handle arrays
    if (Array.isArray(data)) {
        if (data.length === 0) return rootName ? `${rootName}[0]: (empty)` : "(empty list)";

        const first = data[0];
        if (typeof first === "object" && first !== null) {
            const keys = Object.keys(first);
            const header = rootName
                ? `${rootName}[${data.length}]{${keys.join(",")}}: `
                : `items[${data.length}]{${keys.join(",")}}: `;

            const rows = data.map(item => {
                return keys.map(k => String(item[k] ?? "")).join(",");
            }).join(" ");

            return header + rows;
        }

        return (rootName ? `${rootName}[${data.length}]: ` : "") + data.join(" ");
    }

    // Handle objects
    if (typeof data === "object") {
        const keys = Object.keys(data);
        if (keys.length === 0) return rootName ? `${rootName}: (empty)` : "(empty object)";

        const content = keys.map(k => {
            const val = data[k];
            if (typeof val === "object" && val !== null) return `${k}: {complex}`;
            return `${k}: ${val}`;
        }).join(" ");

        return (rootName ? `${rootName}: ` : "") + content;
    }

    // Handle primitives
    return String(data);
}

/**
 * Truncates a string to a limit and adds an AXI-style size hint.
 */
export function truncateAXI(text: string, limit: number = 1000): string {
    if (text.length <= limit) return text;
    return text.substring(0, limit) + `... (truncated, ${text.length} chars total — use --full to see complete body)`;
}
