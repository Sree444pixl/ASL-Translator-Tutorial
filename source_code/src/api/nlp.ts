import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

export type CorrectionOptions = {
  sceneName?: string;
  variables?: Record<string, any>;
};

// Cooldown to avoid spamming logs/requests when network is unavailable
let lastAiFailureAt = 0;
const AI_FAILURE_COOLDOWN_MS = 30_000; // 30s

// Correct raw translation text using AI SDK configuration in yw_manifest.json
export async function correctSentence(rawText: string, options: CorrectionOptions = {}) {
  const sceneName = options.sceneName || 'asl_sentence_corrector';

  if (!globalThis.ywConfig?.ai_config?.[sceneName]) {
    console.error('❌ API Error - Configuration not found:', sceneName);
    // Fallback: return raw text when AI config missing
    return rawText;
  }

  // Skip when offline to prevent noisy failures
  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (isOffline) {
    console.warn('⚠️ API Skip - Offline detected, skipping correction');
    return rawText;
  }

  // Cooldown after recent failure
  if (lastAiFailureAt && Date.now() - lastAiFailureAt < AI_FAILURE_COOLDOWN_MS) {
    console.warn('⚠️ API Skip - In cooldown after previous failure');
    return rawText;
  }

  const config = globalThis.ywConfig.ai_config[sceneName];
  const variables = options.variables || {};
  const systemPrompt = config.system_prompt ? config.system_prompt(variables) : '';

  const openai = createOpenAI({
    baseURL: 'https://api.youware.com/public/v1/ai',
    apiKey: 'sk-YOUWARE'
  });

  try {
    const startTime = Date.now();

    console.log('🤖 AI API Request:', {
      model: config.model,
      scene: sceneName,
      input: rawText.substring(0, 200) + '...',
      parameters: {
        temperature: config.temperature || 0.2,
        maxTokens: config.maxTokens || 2000
      }
    });

    const { text } = await generateText({
      model: openai(config.model),
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: `Please correct and format this ASL transcription into grammatically correct English without changing intended meaning. Keep it concise: "${rawText}"` }
      ],
      temperature: config.temperature || 0.2,
      maxTokens: config.maxTokens || 2000
    });

    console.log('✅ AI API Response:', {
      model: config.model,
      scene: sceneName,
      outputLength: text.length,
      responsePreview: text.substring(0, 200) + '...',
      processingTime: `${Date.now() - startTime}ms`
    });

    return text.trim();
  } catch (error: any) {
    lastAiFailureAt = Date.now();
    const msg = error?.message || String(error);
    // Hide internal proxy domains in logs for clarity
    const sanitized = msg.replace(/\(aiapp\.youware\.com\)/g, '(network)');
    console.error('❌ API Error - Text generation failed:', {
      model: config.model,
      scene: sceneName,
      error: sanitized
    });
    return rawText;
  }
}
