export const CALLS = [];
export let SCRIPT = {};
export function resetApi(script = {}) { CALLS.length = 0; SCRIPT = script; }

export class GrammyError extends Error {
  constructor(description, error_code = 400) {
    super(description);
    this.description = description;
    this.error_code = error_code;
    this.name = "GrammyError";
  }
}

let nextId = 5000;

const handler = {
  get(_target, method) {
    if (method === "then") return undefined;
    return async (...args) => {
      CALLS.push({ method, args });
      const scripted = SCRIPT[method];
      if (typeof scripted === "function") return scripted(...args);
      if (scripted instanceof Error) throw scripted;
      if (scripted !== undefined) return scripted;
      // Sensible defaults for the methods used by the relay.
      switch (method) {
        case "forwardMessage":
        case "copyMessage":
        case "sendMessage":
          return { message_id: nextId++ };
        case "forwardMessages":
        case "copyMessages":
          return args[2].map(() => ({ message_id: nextId++ }));
        case "createForumTopic":
          return { message_thread_id: 900 + (nextId++ % 100), name: args[1] };
        case "getMe":
          return { id: 777, is_bot: true, username: "testbot", first_name: "Test" };
        case "answerCallbackQuery":
        case "deleteMessage":
        case "editMessageText":
        case "editMessageCaption":
        case "setWebhook":
          return true;
        default:
          return true;
      }
    };
  },
};

export class Api {
  constructor(token) { this.token = token; return new Proxy(this, handler); }
}
