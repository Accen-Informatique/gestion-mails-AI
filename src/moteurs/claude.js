// Moteur Claude (API Anthropic, payant)
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { schemaAnalyse, consignes, presenterMail } from '../schema.js';
import { ErreurMoteur } from './erreurs.js';

const client = config.claude.apiKey
  ? new Anthropic({
    apiKey: config.claude.apiKey,
    ...(config.claude.workspaceId
      ? { defaultHeaders: { 'anthropic-workspace-id': config.claude.workspaceId } }
      : {}),
  })
  : null;

const outil = {
  name: 'enregistrer_ticket',
  description: "Enregistre l'analyse du mail sous forme de ticket.",
  input_schema: schemaAnalyse,
};

export const nom = 'claude';
export const disponible = () => !!client;

export async function analyser(mail) {
  let rep;
  try {
    rep = await client.messages.create({
      model: config.claude.modele,
      max_tokens: 4000,
      system: consignes,
      tools: [outil],
      tool_choice: { type: 'tool', name: outil.name },
      messages: [{ role: 'user', content: presenterMail(mail) }],
    });
  } catch (e) {
    // Crédit épuisé, clé refusée ou mal configurée, quota dépassé : le moteur est mis en pause
    const texte = `${e.message || ''}`;
    const bloquant =
      [401, 402, 403, 429].includes(e.status) ||
      /credit|billing|balance|quota|workspace|api key/i.test(texte);
    throw new ErreurMoteur(`Claude : ${texte}`, { bloquant });
  }

  if (rep.stop_reason === 'max_tokens') {
    throw new ErreurMoteur('Claude : réponse coupée (max_tokens atteint)');
  }
  const bloc = rep.content.find(b => b.type === 'tool_use');
  if (!bloc) throw new ErreurMoteur("Claude n'a pas renvoyé d'analyse exploitable");
  return bloc.input;
}
