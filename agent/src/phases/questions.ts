import type { Question } from "../state/run-store.ts";
import type { Phase } from "./types.ts";

// A phase that asks the user each question in turn and finishes once all are answered.
// Answers are kept in run state; the architecture phase turns them into the spec.
export const askPhase = (name: string, questions: Question[]): Phase => ({
  name,
  async run({ state }) {
    const unanswered = questions.find((q) => !state.answers[q.id]?.trim());
    if (unanswered) return { kind: "needs-input", question: unanswered };
    return { kind: "done", summary: `${name}: ${questions.length} answer(s) recorded` };
  },
});

export const QUESTIONS = {
  name: { id: "name", prompt: "What is the app's name?" },
  description: { id: "description", prompt: "Describe the app in a sentence or two: who is it for and what problem does it solve?" },
  functionalities: {
    id: "functionalities",
    prompt: "List the app's functionalities, one per line (or separated by semicolons).",
  },
  flow: {
    id: "flow",
    prompt: "Describe the app's basic flow: what the merchant does from install to everyday use, and what shoppers see.",
  },
  partnerAccount: {
    id: "partnerAccount",
    prompt:
      "Do you have a Shopify Partner account the agent can use? (yes/no) Credentials go in .env, never in this answer.",
  },
  devStore: {
    id: "devStore",
    prompt: "Which development store should the agent install and test the app on? (for example my-store.myshopify.com)",
  },
  hosting: {
    id: "hosting",
    prompt: "Where should the app be hosted? (for example Fly.io, Render, Heroku, or your own server)",
  },
} satisfies Record<string, Question>;
