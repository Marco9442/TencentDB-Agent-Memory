import type { SseFrame } from "./types.js";

type SseInput = string | Uint8Array;

/** Incremental SSE framing. JSON is deliberately not interpreted here. */
export class SseFrameParser {
  private readonly decoder = new TextDecoder();
  private lineBuffer = "";
  private rawLines: string[] = [];
  private dataLines: string[] = [];
  private eventName = "";
  private eventId: string | undefined;
  private retryValue: number | undefined;
  private finished = false;

  push(input: SseInput): SseFrame[] {
    if (this.finished) return [];
    const text = typeof input === "string"
      ? this.decoder.decode() + input
      : this.decoder.decode(input, { stream: true });
    this.lineBuffer += text;
    return this.consumeLines();
  }

  finish(): SseFrame[] {
    if (this.finished) return [];
    this.finished = true;

    const decodedRemainder = this.decoder.decode();
    if (decodedRemainder) this.lineBuffer += decodedRemainder;

    const frames: SseFrame[] = [];
    if (this.lineBuffer.endsWith("\r")) {
      frames.push(...this.consumeLine(this.lineBuffer.slice(0, -1)));
      this.lineBuffer = "";
    } else if (this.lineBuffer) {
      frames.push(...this.consumeLine(this.lineBuffer));
      this.lineBuffer = "";
    }
    frames.push(...this.dispatch());
    return frames;
  }

  private consumeLines(): SseFrame[] {
    const frames: SseFrame[] = [];
    for (;;) {
      let lineEnd = -1;
      let terminatorLength = 0;
      for (let i = 0; i < this.lineBuffer.length; i++) {
        const char = this.lineBuffer[i];
        if (char === "\n") {
          lineEnd = i;
          terminatorLength = 1;
          break;
        }
        if (char === "\r") {
          if (i === this.lineBuffer.length - 1) break;
          lineEnd = i;
          terminatorLength = this.lineBuffer[i + 1] === "\n" ? 2 : 1;
          break;
        }
      }
      if (lineEnd < 0) break;

      const line = this.lineBuffer.slice(0, lineEnd);
      this.lineBuffer = this.lineBuffer.slice(lineEnd + terminatorLength);
      frames.push(...this.consumeLine(line));
    }
    return frames;
  }

  private consumeLine(line: string): SseFrame[] {
    if (line === "") return this.dispatch();
    this.rawLines.push(line);
    if (line.startsWith(":")) return [];

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.eventId = value;
        break;
      case "retry": {
        if (/^\d+$/.test(value)) this.retryValue = Number(value);
        break;
      }
    }
    return [];
  }

  private dispatch(): SseFrame[] {
    if (this.dataLines.length === 0) {
      this.resetFrame();
      return [];
    }
    const frame: SseFrame = {
      event: this.eventName || "message",
      data: this.dataLines.join("\n"),
      ...(this.eventId !== undefined ? { id: this.eventId } : {}),
      ...(this.retryValue !== undefined ? { retry: this.retryValue } : {}),
      raw: this.rawLines.join("\n"),
    };
    this.resetFrame();
    return [frame];
  }

  private resetFrame(): void {
    this.rawLines = [];
    this.dataLines = [];
    this.eventName = "";
    this.eventId = undefined;
    this.retryValue = undefined;
  }
}

export function parseSseFrames(input: SseInput | readonly SseInput[]): SseFrame[] {
  const parser = new SseFrameParser();
  if (Array.isArray(input)) {
    for (const chunk of input) parser.push(chunk);
  } else {
    parser.push(input as SseInput);
  }
  return parser.finish();
}

export const parseSSEFrames = parseSseFrames;
