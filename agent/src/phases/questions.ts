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
    prompt: "List the app's functionalities, separated by semicolons.",
  },
  flow: {
    id: "flow",
    prompt: "Describe the app's basic flow: what the merchant does from install to everyday use, and what shoppers see.",
  },
  hasPlans: {
    id: "hasPlans",
    prompt: "Will the app have paid plans or subscriptions? (yes/no)",
  },
  plans: {
    id: "plans",
    prompt:
      "Describe each plan, separating plans with semicolons: name, price and billing interval, free trial days, and its features (features separated by commas). For example: Free: $0, up to 5 products; Pro: $9/month, 7-day trial, unlimited products, custom badge text",
  },
  developerAccount: {
    id: "developerAccount",
    prompt:
      "Do you have a Shopify developer account with app development permissions? (yes/no) You will log in to it in the browser when the app is created; never type passwords or tokens here.",
  },
  devStore: {
    id: "devStore",
    prompt:
      "Which development store should the app be installed and tested on? (for example my-store.myshopify.com; create one with `shopify store create dev` if you need to)",
  },
  hosting: {
    id: "hosting",
    prompt: "Where should the app be hosted? (for example Fly.io, Render, Heroku, or your own server)",
  },
} satisfies Record<string, Question>;

const isYes = (answer: string | undefined) => /^\s*y(es)?\b/i.test(answer ?? "");

// Asks whether the app is paid and, only if it is, asks for each plan and its features.
export const plansPhase: Phase = {
  name: "plans",
  async run({ state }) {
    if (!state.answers.hasPlans?.trim()) return { kind: "needs-input", question: QUESTIONS.hasPlans };
    if (!isYes(state.answers.hasPlans)) return { kind: "done", summary: "plans: the app is free" };
    if (!state.answers.plans?.trim()) return { kind: "needs-input", question: QUESTIONS.plans };
    return { kind: "done", summary: "plans: recorded" };
  },
};
