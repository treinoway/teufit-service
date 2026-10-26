import { GoogleGenAI } from "@google/genai";
import { LlmProvider } from "./llm-provider.js";
import { AI_MODELS } from "../constants/ai.js";

/**
 * Google Gemini adapter for the LLM facade.
 *
 * Tool definitions: converted from facade format (input_schema) to Gemini's
 *   functionDeclarations format (parameters).
 *
 * Messages: converted from { role: 'user'|'assistant', content: string } to
 *   Gemini's { role: 'user'|'model', parts: [...] } format.
 *
 * Tool results: converted to Gemini's functionResponse format.
 *
 * NOTE: Gemini generates tool call IDs internally — we use a counter-based
 *   ID scheme to correlate tool results back to calls within a single turn.
 */
export class GeminiProvider extends LlmProvider {
  constructor() {
    super();
    this._client = null;
  }

  _getClient() {
    if (!this._client) {
      this._client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }
    return this._client;
  }

  _resolveModel() {
    return process.env.GEMINI_MODEL || AI_MODELS.GEMINI;
  }

  _normalizeProviderError(err) {
    // Map Gemini's HTTP error codes to a `status` property for 429 detection
    const normalized = new Error(err.message);
    normalized.status = err.status ?? err.httpErrorCode ?? err.code;
    throw normalized;
  }

  /**
   * Normalizes the system prompt for Gemini. Anthropic-style block arrays are
   * flattened to a plain string because Gemini's systemInstruction only accepts
   * a string. cache_control metadata on blocks is discarded silently.
   *
   * @param {string | Array<{type: string, text: string}>} system
   * @returns {string}
   */
  _resolveSystemInstruction(system) {
    if (Array.isArray(system)) {
      return system.map((block) => block.text).join('\n');
    }
    return system;
  }

  async chat({ system, tools, messages, maxTokens }) {
    const client = this._getClient();
    const model = this._resolveModel();

    const geminiTools = this._convertTools(tools);
    const geminiContents = this._convertMessages(messages);

    let response;
    try {
      response = await client.models.generateContent({
        model,
        contents: geminiContents,
        config: {
          systemInstruction: this._resolveSystemInstruction(system),
          maxOutputTokens: maxTokens,
          tools: geminiTools,
        },
      });
    } catch (err) {
      this._normalizeProviderError(err);
    }

    return this._normalizeResponse(response);
  }

  async *chatStream({ system, tools, messages, maxTokens }) {
    const client = this._getClient();
    const model = this._resolveModel();

    const geminiTools = this._convertTools(tools);
    const geminiContents = this._convertMessages(messages);

    let stream;
    try {
      stream = await client.models.generateContentStream({
        model,
        contents: geminiContents,
        config: {
          systemInstruction: this._resolveSystemInstruction(system),
          maxOutputTokens: maxTokens,
          tools: geminiTools,
        },
      });
    } catch (err) {
      this._normalizeProviderError(err);
    }

    // The last chunk contains the full candidates array including any tool calls.
    let lastChunk = null;
    let lastUsageMetadata = null;

    try {
      for await (const chunk of stream) {
        lastChunk = chunk;
        if (chunk.usageMetadata) lastUsageMetadata = chunk.usageMetadata;

        const text = chunk.candidates?.[0]?.content?.parts
          ?.filter((p) => p.text != null)
          ?.map((p) => p.text)
          ?.join('');

        if (text) {
          yield { type: 'text_delta', content: text };
        }
      }
    } catch (err) {
      this._normalizeProviderError(err);
    }

    if (!lastChunk) {
      const normalized = new Error('Gemini stream ended with no chunks');
      normalized.status = 502;
      throw normalized;
    }

    const response = this._normalizeResponse(lastChunk);
    response.usage = this._normalizeUsage(lastUsageMetadata);
    yield { type: 'complete', response };
  }

  _convertTools(tools) {
    const functionDeclarations = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }));

    return [{ functionDeclarations }];
  }

  _convertMessages(messages) {
    return messages.map((message) => {
      const role = message.role === "assistant" ? "model" : "user";

      // Content may be a plain string (text turn) or an array (tool result turn in history)
      if (typeof message.content === "string") {
        return { role, parts: [{ text: message.content }] };
      }

      // Array content — handle rawContent from a previous model turn (functionCall parts)
      // or user-supplied tool result turns
      if (Array.isArray(message.content)) {
        const parts = message.content.flatMap((item) => {
          if (item.type === "text") return [{ text: item.text }];
          if (item.type === "functionCall")
            return [{ functionCall: item.functionCall }];
          if (item.type === "functionResponse")
            return [{ functionResponse: item.functionResponse }];
          return [];
        });
        return { role, parts };
      }

      return { role, parts: [{ text: String(message.content) }] };
    });
  }

  _normalizeResponse(response) {
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const textParts = parts.filter((part) => part.text != null);
    const functionCallParts = parts.filter((part) => part.functionCall != null);

    const hasToolCalls = functionCallParts.length > 0;
    const stopReason = hasToolCalls ? "tool_use" : "end_turn";

    const text = textParts.map((part) => part.text).join("") || null;

    const toolCalls = functionCallParts.map((part, index) => ({
      // Gemini does not return tool call IDs — we generate deterministic IDs
      id: `gemini-tool-${index}`,
      name: part.functionCall.name,
      input: part.functionCall.args ?? {},
    }));

    // rawContent preserves the Gemini content parts for multi-turn tool result messages
    const rawContent = candidate?.content ?? { parts };

    return {
      stopReason,
      text,
      toolCalls,
      rawContent,
      usage: this._normalizeUsage(response.usageMetadata),
    };
  }

  // Maps Gemini usageMetadata to the normalized usage shape, or null when absent.
  _normalizeUsage(metadata) {
    if (!metadata) return null;
    const cached = metadata.cachedContentTokenCount ?? 0;
    return {
      inputTokens: (metadata.promptTokenCount ?? 0) - cached,
      outputTokens: (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
  }

  buildToolResultMessages(previousAssistantContent, toolResults) {
    // The assistant message uses the raw Gemini content object (role + parts)
    const assistantMessage = {
      role: "model",
      parts: previousAssistantContent.parts,
    };

    // Tool results become a user turn with functionResponse parts
    const functionResponseParts = toolResults.map((result, index) => {
      // Match by index — Gemini has no native tool call IDs in the content
      const functionCallPart = previousAssistantContent.parts?.filter(
        (p) => p.functionCall != null,
      )?.[index];
      const name = functionCallPart?.functionCall?.name ?? result.toolCallId;

      return {
        functionResponse: {
          name,
          response: { result: result.content },
        },
      };
    });

    const toolResultMessage = {
      role: "user",
      parts: functionResponseParts,
    };

    return [assistantMessage, toolResultMessage];
  }
}
