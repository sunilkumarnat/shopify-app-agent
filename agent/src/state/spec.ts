import { z } from "zod";

export const SurfaceSchema = z.enum(["embedded-admin", "theme-extension"]);

// The single source of truth for a generated app, built up from the user's answers.
export const AppSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  functionalities: z.array(z.string().min(1)).min(1),
  flow: z.string().min(1),
  surfaces: z.array(SurfaceSchema).min(1),
});

export type AppSpec = z.infer<typeof AppSpecSchema>;
