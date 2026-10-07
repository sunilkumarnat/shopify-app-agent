import { z } from "zod";

export const SurfaceSchema = z.enum(["embedded-admin", "theme-extension"]);

// The single source of truth for a generated app, built up from the user's answers.
export const AppSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  functionalities: z.array(z.string().min(1)).min(1),
  flow: z.string().min(1),
  surfaces: z.array(SurfaceSchema).min(1),
  // One entry per paid plan (name, price, interval, trial, features); empty for a free app.
  plans: z.array(z.string().min(1)).default([]),
  scopes: z.array(z.string()).default([]),
});

export type AppSpec = z.infer<typeof AppSpecSchema>;
