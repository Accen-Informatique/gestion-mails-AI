// Moteur gratuit : toute API compatible OpenAI (/chat/completions)
// Fonctionne avec Ollama (local), Groq, Google Gemini, Mistral, OpenRouter…
import { config } from '../config.js';
import { schemaAnalyse, consignes, presenterMail } from '../schema.js';
import { ErreurMoteur } from './erreurs.js';

const g = config.gratuit;

export const nom = 'gratuit';
export const disponible = () => !!(g.url && g.modele);

// Les modèles gratuits n'ont pas tous l'appel d'outil : on décrit le JSON attendu en clair
const formatAttendu = Object.entries(schemaAnalyse.properties)
  .map(([cle, def]) => {
    const valeurs = def.enum ? ` — une valeur parmi : ${def.enum.join(' | ')}` : '';
    const desc = def.description ? ` — ${def.description}` : '';
    return `- "${cle}" (${def.type})${valeurs}${desc}`;
  })
  .join('\n');

const consignesJson = `${consignes}
- Réponds UNIQUEMENT par un objet JSON valide, sans texte autour, avec exactement ces clés :
${formatAttendu}`;

export async function analyser(mail) {
  const corps = {
    model: g.modele,
    temperature: 0.2,
    messages: [
      { role: 'system', content: consignesJson },
      { role: 'user', content: presenterMail(mail) },
    ],
    ...(g.modeJson ? { response_format: { type: 'json_object' } } : {}),
  };

  let res;
  try {
    res = await fetch(`${g.url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(g.apiKey ? { Authorization: `Bearer ${g.apiKey}` } : {}),
      },
      body: JSON.stringify(corps),
      signal: AbortSignal.timeout(g.delaiSecondes * 1000),
    });
  } catch (e) {
    throw new ErreurMoteur(`Moteur gratuit injoignable (${g.url}) : ${e.message}`);
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.error?.message || json.error || res.statusText;
    throw new ErreurMoteur(`Moteur gratuit : HTTP ${res.status} ${message}`, {
      bloquant: [401, 402, 403, 429].includes(res.status),
    });
  }

  const texte = json.choices?.[0]?.message?.content || '';
  if (json.choices?.[0]?.finish_reason === 'length') {
    throw new ErreurMoteur('Moteur gratuit : réponse coupée (trop longue)');
  }
  return extraireJson(texte);
}

// Récupère l'objet JSON même si le modèle l'entoure de texte ou de ```json
function extraireJson(texte) {
  const debut = texte.indexOf('{');
  const fin = texte.lastIndexOf('}');
  if (debut === -1 || fin <= debut) {
    throw new ErreurMoteur("Moteur gratuit : pas de JSON dans la réponse");
  }
  try {
    return JSON.parse(texte.slice(debut, fin + 1));
  } catch {
    throw new ErreurMoteur('Moteur gratuit : JSON invalide dans la réponse');
  }
}
