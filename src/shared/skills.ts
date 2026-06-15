export type HerSkillParameter = {
  name: string;
  description?: string;
  required?: boolean;
  defaultValue?: string;
};

export type HerSkillStep = {
  toolName: string;
  arguments: Record<string, unknown>;
  title?: string;
};

export type HerSkillDefinition = {
  id: string;
  name: string;
  trigger: string;
  description?: string;
  parameters: HerSkillParameter[];
  steps: HerSkillStep[];
  requiredCapabilities: string[];
  risks: string[];
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt?: string;
};

export type HerSkillPreview = {
  name: string;
  trigger: string;
  description?: string;
  parameters: HerSkillParameter[];
  steps: Array<HerSkillStep & {
    summary: string;
    risk: string;
    riskLabel: string;
    capability?: string;
  }>;
  requiredCapabilities: string[];
  risks: string[];
  requiresConfirmation: boolean;
};

export type HerSkillSaveInput = {
  name: string;
  trigger: string;
  description?: string;
  parameters?: HerSkillParameter[];
  steps: HerSkillStep[];
  overwrite?: boolean;
};

export type HerSkillRunInput = {
  skillId?: string;
  trigger?: string;
  parameters?: Record<string, string>;
};
