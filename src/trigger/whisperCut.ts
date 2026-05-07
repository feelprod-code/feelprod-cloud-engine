import { task } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// === Zod Models for LLM JSON output ===
const DeletedSegmentSchema = z.object({
  text: z.string().describe("Le mot, l'hésitation ('euh', 'bah') ou la phrase exacte supprimée."),
  reason: z.string().describe("Raison courte de la suppression (ex: hésitation, logistique, répétition)."),
  start_time: z.number().describe("Timestamp estimé de début de la coupure (en secondes).")
});

const ParagraphSchema = z.object({
  text: z.string().describe("Le texte complet du paragraphe ou de l'idée abordée."),
  start_time: z.number().describe("Timestamp de début de cette portion (en secondes)."),
  end_time: z.number().describe("Timestamp de fin de cette portion (en secondes).")
});

const SectionSchema = z.object({
  subtitle: z.string().describe("Le sous-titre de cette section."),
  paragraphs: z.array(ParagraphSchema).describe("Liste des paragraphes conservés pour le cours."),
  deleted_segments: z.array(DeletedSegmentSchema).describe("Liste exacte et exhaustive de TOUS les mots supprimés et bavardages retirés de cette section.")
});

const ChapterSchema = z.object({
  main_title: z.string().describe("Titre principal de ce grand chapitre du cours."),
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
  
  run: async (payload: { videoId: string, wordsData: {word: string, start: number, end: number}[], knownChapters?: string[] }) => {
    console.log("🎬 Début du traitement vidéo dans le Cloud :", payload.videoId);

    // === LLM Semantic Processing ===
    console.log("🧠 Analyse sémantique par blocs avec GPT-4o (OpenRouter)...");
    
    const knownChapters = payload.knownChapters || [];
    const knownChaptersStr = knownChapters.length > 0 ? knownChapters.map(c => `"${c}"`).join(", ") : "Aucun chapitre pour l'instant (c'est le début).";
    
    const prompt = `Tu es un monteur vidéo sémantique expert et un rédacteur pédagogique extrêmement rigoureux.
Voici la transcription chronométrée d'une PARTIE d'un cours vidéo.
Ton but est de restructurer le texte de manière ultra-minimaliste et intelligente :
1. Crée des Chapitres avec un "main_title". IMPORTANT : Voici la liste des chapitres déjà existants : [${knownChaptersStr}]. Si le sujet s'inscrit logiquement dans l'un de ces chapitres, réutilise EXACTEMENT le même "main_title". Sinon, crées-en un nouveau.
2. Sous chaque chapitre, crée des "sections" avec un "subtitle".
3. Dans chaque section, découpe le texte UTILE en "paragraphs" (1 idée = 1 paragraphe).
4. OBLIGATION ABSOLUE (SUPPRESSION) : Tu dois traquer chaque suppression. Tout ce que tu ne gardes pas dans "paragraphs" (les hésitations comme "euh", bégaiements, répétitions, bavardage logistique) DOIT être listé mot pour mot dans la liste \`deleted_segments\` avec un start_time.
5. OBLIGATION ABSOLUE (CONSERVATION) : GARDE le contenu du cours, TOUTES LES ANECDOTES liées au cours. GARDE INTÉGRALEMENT les descriptions de techniques, explications de diapositives, ou lorsqu'il dessine au tableau. Ne coupe jamais ces moments d'explication visuelle. Ne change pas les mots conservés.
6. Extrait ou estime les start_time et end_time (en secondes) pour chaque paragraphe et chaque suppression.
Si tu supprimes le moindre "euh", tu dois obligatoirement créer un objet DeletedSegment pour le signaler.`;

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
