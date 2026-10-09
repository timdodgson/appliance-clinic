/** An entry of prompts/registry.json (prompts/README.md). */
export interface PromptSource {
  file: string;
  declarations?: string[];
}

export interface PromptChange {
  version: number;
  date: string;
  fingerprint: string;
  change: string;
}

export interface PromptEntry {
  id: string;
  version: number;
  purpose: string;
  owner: string;
  consumers: string[];
  source: PromptSource[];
  runtimeVersion?: { file: string; constant: string; value: string };
  input: string;
  output: string;
  changelog: PromptChange[];
}

export interface PromptRegistry {
  description: string;
  prompts: PromptEntry[];
}
