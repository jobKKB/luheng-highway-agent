// Only explicitly typed, pre-execution input failures may be returned to the
// planner. Generic errors, authorization and uncertain effects remain terminal.
export class ToolInputError extends Error {
  constructor(message, code = "TOOL_ARGUMENTS") {
    super(message);
    this.name = "ToolInputError";
    this.code = code;
  }
}

export class AgentLimitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AgentLimitError";
    this.code = code;
  }
}
