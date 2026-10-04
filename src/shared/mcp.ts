import { z } from 'zod';

export interface McpToolInfo {
  name: string;
  description: string;
  /** MCP annotations, shown to the owner; not enforced. */
  readOnly?: boolean;
  destructive?: boolean;
}
/** A remote MCP server as the browser sees it: header values never leave the server. */
export interface McpServerInfo {
  id: string;
  name: string;
  url: string;
  headerNames: string[];
  enabled: boolean;
  /** null: every Dot; otherwise only these Dots. */
  dotIds: string[] | null;
  /** null: every tool in the reviewed list; otherwise only these tools. */
  allowedTools: string[] | null;
  /** The tool list from the last successful test, which the owner reviews. */
  tools: McpToolInfo[];
  lastError: string | null;
  checkedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export const mcpServerNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, {
    message: 'Use lowercase letters, digits, and hyphens (max 32).',
  });
const headerNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,64}$/, { message: 'Invalid header name.' });
export const mcpServerInputSchema = z
  .object({
    name: mcpServerNameSchema,
    url: z
      .string()
      .trim()
      .url()
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), {
        message: 'Use an http(s) URL.',
      }),
    /**
     * Headers to keep. A value sets or replaces a header; a missing value keeps
     * the stored one; a stored header not listed here is removed.
     */
    headers: z
      .array(
        z
          .object({
            name: headerNameSchema,
            value: z.string().max(8192).optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    enabled: z.boolean().default(true),
    dotIds: z.array(z.string().min(1)).max(100).nullable().default(null),
    allowedTools: z
      .array(z.string().min(1).max(128))
      .max(500)
      .nullable()
      .default(null),
  })
  .strict();
export type McpServerInput = z.input<typeof mcpServerInputSchema>;
