import { task } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

// We will instantiate OpenAI inside the run function to avoid build-time missing API key errors.

// === Zod Models for LLM JSON output ===
const DeletedSegmentSchema = z.object({
  text: z.string().describe("Le mot, l'hésitation ('euh', 'bah') ou la phrase exacte supprimée."),
  reason: z.string().describe("Raison courte de la suppression (ex: hésitation, logistique, répétition)."),
  anchor_text: z.string().describe("Les 5 premiers mots du passage supprimé, copiés textuellement depuis la transcription.")
});

const ParagraphSchema = z.object({
  text: z.string().describe("Le texte complet du paragraphe ou de l'idée abordée."),
  anchor_text: z.string().describe("Les 5 premiers mots du paragraphe, copiés EXACTEMENT depuis la transcription (pour ancrage timestamp).")
});

const SectionSchema = z.object({
  subtitle: z.string().describe("Le sous-titre de cette section."),
  paragraphs: z.array(ParagraphSchema).describe("Liste des paragraphes conservés pour le cours."),
  deleted_segments: z.array(DeletedSegmentSchema).describe("Liste exacte et exhaustive de TOUS les mots supprimés et bavardages retirés de cette section.")
});

const ChapterSchema = z.object({
  main_title: z.string().describe("Titre principal de ce grand chapitre du cours."),
  anchor_text: z.string().describe("Les 5 premiers mots du chapitre, copiés EXACTEMENT depuis la transcription."),
  sections: z.array(SectionSchema)
});

const CourseStructureSchema = z.object({
  chapters: z.array(ChapterSchema)
});

// Helper for formatting time
function formatTimeShort(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const h = Math.floor(m / 60);
  const remainingM = m % 60;
  if (h > 0) {
    return `[${h.toString().padStart(2, '0')}:${remainingM.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}]`;
  }
  return `[${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}]`;
}

export const whisperAndCutTask = task({
  id: "whisper-and-cut",
  maxDuration: 3600, 
  
  run: async (payload: { videoId: string, wordsData: {word: string, start: number, end: number}[], knownChapters?: string[], referenceContext?: string, glossaryContext?: string, openrouterApiKey?: string }) => {
    console.log("🎬 Début du traitement vidéo dans le Cloud :", payload.videoId);

    const apiKey = payload.openrouterApiKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("Missing OPENROUTER_API_KEY in environment or payload.");
    }

    const openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: apiKey,
    });

    // === LLM Semantic Processing ===
    console.log("🧠 Analyse sémantique par blocs avec GPT-4o (OpenRouter)...");
    
    const knownChapters = payload.knownChapters || [];
    const knownChaptersStr = knownChapters.length > 0 ? knownChapters.map(c => `"${c}"`).join(", ") : "Aucun chapitre pour l'instant (c'est le début).";
    
    const prompt = `Tu es un monteur vidéo sémantique expert et un rédacteur pédagogique extrêmement rigoureux.
Voici la transcription chronométrée d'une PARTIE d'un cours vidéo d'ostéopathie.
Chaque ligne du transcript commence par un timestamp Whisper précis : "HH:MM:SS - HH:MM:SS texte".

${payload.referenceContext || ""}
${payload.glossaryContext || ""}

Ton but est de restructurer le texte de manière ultra-minimaliste et intelligente :
1. Crée des Chapitres avec un "main_title". IMPORTANT : Voici la liste des chapitres déjà existants : [${knownChaptersStr}]. Si le sujet s'inscrit logiquement dans l'un de ces chapitres, réutilise EXACTEMENT le même "main_title". Sinon, crées-en un nouveau.
2. Pour chaque chapitre, remplis le champ "anchor_text" avec les 5 PREMIERS MOTS EXACTS du texte transcrit où ce chapitre commence. Copie ces mots TEXTUELLEMENT depuis la transcription — ne les reformule pas.
3. Sous chaque chapitre, crée des "sections" avec un "subtitle".
4. Dans chaque section, découpe le texte UTILE en "paragraphs" (1 idée = 1 paragraphe). Pour chaque paragraphe, remplis "anchor_text" avec les 5 PREMIERS MOTS EXACTS.
5. OBLIGATION ABSOLUE (SUPPRESSION) : Tu dois traquer chaque suppression. SEULS ces éléments doivent être supprimés :
   - Hésitations verbales : "euh", "bah", "hein", bégaiements, mots doublés par erreur
   - Bavardage purement logistique : "on fait une pause café", "vous pouvez vous asseoir", "le micro marche ?"
   - Répétitions identiques (le même mot dit 3 fois d'affilée par erreur)
   Tout ce qui est supprimé DOIT être listé dans \`deleted_segments\`.

6. OBLIGATION ABSOLUE (CONSERVATION — RÈGLE CRITIQUE) :
   Tu GARDES OBLIGATOIREMENT et INTÉGRALEMENT les moments suivants :
   a) ANECDOTES DE PATIENTS : cas cliniques, histoires de patients. NE JAMAIS COUPER.
   b) DESCRIPTIONS AU TABLEAU / DESSINS : "je vous dessine", "regardez ici". IRREMPLAÇABLES en vidéo.
   c) DÉMONSTRATIONS PRATIQUES : gestes, palpations, positionnement des mains.
   d) EXPLICATIONS DE DIAPOSITIVES : ce qui est affiché à l'écran.
   e) RÉFÉRENCES HISTORIQUES : Sutherland, Steele, Still, etc.
   f) MÉTAPHORES ET ANALOGIES : "c'est comme un ballon", "imaginez une éponge".
   EN CAS DE DOUTE, GARDE LE CONTENU. Ne change pas les mots conservés.

RÈGLE CRITIQUE SUR LES TIMESTAMPS :
- NE JAMAIS inventer, estimer ou calculer de timestamp.
- Utilise UNIQUEMENT le champ "anchor_text" pour indiquer où commence chaque élément.
- Les timestamps seront calculés automatiquement depuis les données Whisper.`;

    const BATCH_SIZE_SECONDS = 300.0;
    const wordsData = payload.wordsData;
    
    if (!wordsData || wordsData.length === 0) {
      throw new Error("Aucun mot fourni dans le payload.");
    }
    
    const videoEndTime = wordsData[wordsData.length - 1].end;
    let allChapters: any[] = [];
    let currentTime = 0.0;
    let batchIndex = 1;
    const totalBatches = Math.ceil(videoEndTime / BATCH_SIZE_SECONDS);
    
    while (currentTime < videoEndTime) {
      console.log(`⏳ Traitement du bloc ${batchIndex}/${totalBatches} (${formatTimeShort(currentTime)} à ${formatTimeShort(currentTime + BATCH_SIZE_SECONDS)})...`);
      
      const batchWords = wordsData.filter(w => w.start >= currentTime && w.start < currentTime + BATCH_SIZE_SECONDS);
      
      if (batchWords.length === 0) {
        currentTime += BATCH_SIZE_SECONDS;
        batchIndex++;
        continue;
      }
      
      let transcriptBlocks: string[] = [];
      let currentBlockWords: string[] = [];
      let blockStart = batchWords[0].start;
      
      for (let i = 0; i < batchWords.length; i++) {
        const w = batchWords[i];
        currentBlockWords.push(w.word);
        
        if (w.end - blockStart >= 15.0 || i === batchWords.length - 1) {
          const text = currentBlockWords.join(" ");
          transcriptBlocks.push(`[${formatTimeShort(blockStart)} - ${formatTimeShort(w.end)}] ${text}`);
          if (i !== batchWords.length - 1) {
            blockStart = w.end;
          }
          currentBlockWords = [];
        }
      }
      
      const fullTranscriptText = transcriptBlocks.join("\n");
      
      try {
        const response = await openai.chat.completions.parse({
          model: "openai/gpt-4o-2024-08-06",
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: fullTranscriptText }
          ],
          response_format: zodResponseFormat(CourseStructureSchema, "course_structure"),
        });
        
        const parsedStructure = response.choices[0]?.message?.parsed;
        if (parsedStructure && parsedStructure.chapters) {
          allChapters.push(...parsedStructure.chapters);
        }
      } catch (e) {
        console.error(`⚠️ Erreur lors du traitement du bloc ${batchIndex} :`, e);
      }
      
      currentTime += BATCH_SIZE_SECONDS;
      batchIndex++;
    }

    return {
      status: "success",
      chapters: allChapters,
      message: "Analyse sémantique complète générée."
    };
  },
});
