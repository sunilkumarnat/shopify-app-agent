import { z } from "zod";

export const SurfaceSchema = z.enum(["embedded-admin", "theme-extension"]);

// The single source of truth for a generated app. Every phase reads it and may extend it.
export const AppSpecSchema = z.object({
  name: z.string().min(1),
  idea: z.string().min(1),
  surfaces: z.array(SurfaceSchema).min(1),
  stories: z.array(z.string()).default([]),
  scopes: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
});

export type AppSpec = z.infer<typeof AppSpecSchema>;
