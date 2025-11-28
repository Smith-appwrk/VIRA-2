import { OpenAI } from 'openai';
import { CONFIG } from '../config';

export class OpenAIService {
    private openai: OpenAI;

    constructor(apiKey: string) {
        this.openai = new OpenAI({ apiKey });
    }

    async detectLanguage(text: string): Promise<string> {
        const languageDetection = await this.openai.chat.completions.create({
            model: CONFIG.OPENAI_MODEL,
            messages: [
                {
                    role: "system",
                    content: "Detect the language of the following text and respond with the language code only (e.g., 'en' for English, 'es' for Spanish, etc.)"
                },
                { role: "user", content: text }
            ],
            temperature: CONFIG.LANGUAGE_DETECTION_TEMPERATURE,
        });

        return languageDetection.choices[0].message.content?.toLowerCase() || 'en';
    }

    async analyzeIntent(message: string): Promise<string> {
        const intentAnalysis = await this.openai.chat.completions.create({
            model: CONFIG.OPENAI_MODEL,
            messages: [
                {
                    role: "system",
                    content: "Analyze if the given message is a question or error or RELATED_STATEMENT or can be ignored. Respond with exactly: QUESTION, ERROR, RELATED_STATEMENT or IGNORE. Examples: 'How do I...' -> QUESTION, 'I'm getting error...' -> ERROR, 'Any info regarding warehouse checkin checkout yard, validator, containg PIN, password etc' ->  RELATED_STATEMENT, 'Good morning, any general convo that seams is not asked or given to bot just some people interacting with each other' -> IGNORE"
                },
                { role: "user", content: message }
            ],
            temperature: CONFIG.MESSAGE_INTENT_TEMPERATURE,
        });

        return intentAnalysis.choices[0].message.content || 'IGNORE';
    }

    async getCompletion(messages: Array<{ role: string; content: string }>): Promise<string> {
        const completion = await this.openai.chat.completions.create({
            model: CONFIG.OPENAI_MODEL,
            messages: messages as any,
            temperature: CONFIG.RESPONSE_TEMPERATURE,
            frequency_penalty: CONFIG.COMPLETION_FREQUENCY_PENALTY,
            presence_penalty: CONFIG.COMPLETION_PRESENCE_PENALTY
        });

        return completion.choices[0].message.content || '';
    }

    async translateText(text: string, targetLanguage: string): Promise<string> {
        const translation = await this.openai.chat.completions.create({
            model: CONFIG.OPENAI_MODEL,
            messages: [
                {
                    role: "system",
                    content: `Translate the following text to ${targetLanguage}`
                },
                { role: "user", content: text }
            ],
            temperature: CONFIG.TRANSLATION_TEMPERATURE,
        });

        return translation.choices[0].message.content || text;
    }

    async analyzeImage(base64Image: string, prompt: string): Promise<string> {
        const visionResponse = await this.openai.chat.completions.create({
            model: CONFIG.OPENAI_MODEL,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ] as any
                }
            ],
            max_tokens: 300
        });

        return visionResponse.choices[0].message.content || '';
    }

    async findRelevantImages(question: string, imagePaths: Record<string, string>, maxImages: number = 3): Promise<string[]> {
        if (!question || !imagePaths || Object.keys(imagePaths).length === 0) {
            return [];
        }

        const imageFilenames = Object.keys(imagePaths).map(path => {
            return path.toLowerCase()
                .replace(/\.[^/.]+$/, "")
                .replace(/[_-]/g, " ");
        });

        const prompt = `
You are an image matching assistant specialized in finding exact matches between questions and image descriptions.

Given a user's question and image filenames, return ONLY the indices of images that are EXACTLY relevant to the question.
Do not return partial matches or thematically similar images.

User question: "${question}"

Available image descriptions (indices start at 0):
${imageFilenames.map((name, i) => `${i}: ${name}`).join("\n")}

Return a JSON array containing ONLY the indices of perfectly matching images. Return [] if no exact matches found.

Example outputs:
- Perfect match: [2]
- Multiple matches: [1, 3] 
- No matches: []`;

        const completion = await this.openai.chat.completions.create({
            model: CONFIG.OPENAI_MODEL,
            messages: [
                {
                    role: "system",
                    content: "You are a precise image matcher that only returns exact matches."
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.1,
        });

        try {
            const responseContent = completion.choices[0].message.content || '[]';
            const indices = JSON.parse(responseContent);
            const selectedPaths = indices
                .map((i: number) => imagePaths[Object.keys(imagePaths)[i]])
                .filter((path: string) => path);

            return selectedPaths.slice(0, maxImages);
        } catch (error) {
            console.error("Error finding relevant images:", error);
            return [];
        }
    }

    async canShowGraphically(question: string, data: any): Promise<{ canGraph: boolean; graphType?: string; reason?: string }> {
        if (!question || !data) {
            return { canGraph: false };
        }

        const hasNumericalData = this._hasGraphableData(data);
        if (!hasNumericalData) {
            return { canGraph: false, reason: "Data does not contain numerical values suitable for graphing" };
        }

        const prompt = `
Analyze if the following data should be displayed as a graph.
Return a valid JSON object with:
- canGraph: boolean (true if data can be displayed as a graph, false otherwise)
- graphType: "bar" | "line" | "pie" (only if canGraph is true)
- reason: string explaining your decision

The data is graphable if:
- It contains numeric values that can be compared or tracked
- The question is asking for a comparison, trend, or distribution
- Visualization would enhance understanding

Question: "${question}"
Data:
${JSON.stringify(data)}

Return ONLY a valid JSON object like:
{
  "canGraph": true,
  "graphType": "bar",
  "reason": "Data contains numeric values that can be compared"
}`;

        try {
            const completion = await this.openai.chat.completions.create({
                model: CONFIG.OPENAI_MODEL,
                messages: [
                    {
                        role: "system",
                        content: "You are a data visualization expert. Your job is to determine if data can be meaningfully displayed as a graph and what type of graph would be most appropriate."
                    },
                    { role: "user", content: prompt }
                ],
                temperature: 0.3,
                response_format: { type: "json_object" }
            });

            const responseContent = completion.choices[0].message.content || '{}';
            const parsedResponse = JSON.parse(responseContent);

            if (typeof parsedResponse.canGraph !== 'boolean') {
                return this._analyzeDataFallback(data);
            }

            return parsedResponse;
        } catch (error) {
            console.error("Error in graph analysis:", error);
            return this._analyzeDataFallback(data);
        }
    }

    private _hasGraphableData(data: any): boolean {
        if (Array.isArray(data)) {
            return data.some(item => {
                if (typeof item === 'object') {
                    return Object.values(item).some(val => typeof val === 'number');
                }
                return typeof item === 'number';
            });
        } else if (typeof data === 'object') {
            return Object.values(data).some(val => {
                if (typeof val === 'number') return true;
                if (Array.isArray(val)) return val.some(v => typeof v === 'number');
                return false;
            });
        }
        return false;
    }

    private _analyzeDataFallback(data: any): { canGraph: boolean; graphType?: string; reason: string } {
        let canGraph = false;
        let graphType: string | undefined = undefined;
        let reason = "Unable to determine if data is graphable";

        if (Array.isArray(data) && data.length >= 2) {
            const hasNumericValues = data.some(item => {
                if (typeof item === 'number') return true;
                if (typeof item === 'object') {
                    return Object.values(item).some(v => typeof v === 'number');
                }
                return false;
            });

            if (hasNumericValues) {
                canGraph = true;
                graphType = "bar";
                reason = "Data contains multiple items with numeric values";
            }
        }

        return { canGraph, graphType, reason };
    }

    extractGraphData(text: string): { labels: string[]; data: number[]; units: string[] } | null {
        console.log('Extracting graph data from text:', text);

        const patterns = {
            labelValueUSD: /([A-Za-z\s&]+?)\s*[-:]\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(USD|dollars?)/gi,
            labelSpaceValueUSD: /([A-Za-z\s&]+?)\s+(\d+(?:,\d{3})*(?:\.\d+)?)\s*(USD|dollars?)/gi,
            labelValue: /([A-Za-z\s&]+?)\s*[-:]\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(%|units?|pieces?)?/gi,
            numbers: /\b\d+(?:,\d{3})*(?:\.\d+)?\b/g,
            currency: /\$?\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:USD|dollars?)?/gi
        };

        const matches: Array<{ label: string; value: number; unit: string }> = [];
        let match: RegExpExecArray | null;

        const lines = text.split('\n').filter(line => line.trim());
        for (const line of lines) {
            if (line.includes('█') || (line.match(/[A-Za-z]/) && line.match(/\d+\s*USD/i))) {
                const nameMatch = line.match(/^([A-Za-z\s&]+?)(?:\s{3,}|█)/);
                const valueMatch = line.match(/(\d+(?:,\d{3})*(?:\.\d+)?)\s*(USD|dollars?)/i);

                if (nameMatch && valueMatch && !line.toLowerCase().includes('total')) {
                    const value = parseFloat(valueMatch[1].replace(/,/g, ''));
                    if (!isNaN(value)) {
                        matches.push({
                            label: nameMatch[1].trim(),
                            value: value,
                            unit: valueMatch[2] || 'USD'
                        });
                    }
                }
            }
        }

        if (matches.length > 0) {
            console.log('Extracted matches from detention format:', matches);
            return {
                labels: matches.map(m => m.label),
                data: matches.map(m => m.value),
                units: matches.map(m => m.unit)
            };
        }

        const textCopy1 = text.slice();
        while ((match = patterns.labelValueUSD.exec(textCopy1)) !== null) {
            const value = parseFloat(match[2].replace(/,/g, ''));
            if (!isNaN(value)) {
                matches.push({
                    label: match[1].trim(),
                    value: value,
                    unit: match[3] || 'USD'
                });
            }
        }

        if (matches.length === 0) {
            const textCopy2 = text.slice();
            while ((match = patterns.labelSpaceValueUSD.exec(textCopy2)) !== null) {
                const value = parseFloat(match[2].replace(/,/g, ''));
                if (!isNaN(value)) {
                    matches.push({
                        label: match[1].trim(),
                        value: value,
                        unit: match[3] || 'USD'
                    });
                }
            }
        }

        if (matches.length === 0) {
            const textCopy3 = text.slice();
            while ((match = patterns.labelValue.exec(textCopy3)) !== null) {
                const value = parseFloat(match[2].replace(/,/g, ''));
                if (!isNaN(value)) {
                    matches.push({
                        label: match[1].trim(),
                        value: value,
                        unit: match[3] || ''
                    });
                }
            }
        }

        console.log('Extracted matches:', matches);

        if (matches.length > 0) {
            return {
                labels: matches.map(m => m.label),
                data: matches.map(m => m.value),
                units: matches.map(m => m.unit)
            };
        }

        const numbers = text.match(patterns.numbers)?.map(num => parseFloat(num.replace(/,/g, ''))) || [];
        const fallbackLines = text.split('\n').filter(line => line.trim());
        const labels = fallbackLines.slice(0, numbers.length).map(line =>
            line.replace(/\d+.*/, '').replace(/[█\s]+/g, '').trim()
        ).filter(label => label.length > 0);

        console.log('Fallback - Numbers:', numbers);
        console.log('Fallback - Labels:', labels);

        if (numbers.length === 0 || labels.length === 0) {
            return null;
        }

        return {
            labels: labels.slice(0, numbers.length),
            data: numbers.slice(0, labels.length),
            units: []
        };
    }

    async extractGraphDataWithAI(text: string, question: string = ''): Promise<{ labels: string[]; data: number[]; units: string[]; title?: string; chartType?: string } | null> {
        try {
            console.log('Using OpenAI to extract graph data from:', text);

            const prompt = `
Extract data from the following text that can be used to create a graph/chart.

Text: "${text}"
Question context: "${question}"

Please analyze the text and extract:
1. Labels/categories (company names, time periods, etc.)
2. Numerical values associated with each label
3. Units (USD, %, etc.)

Return a JSON object with this exact structure:
{
  "labels": ["Label1", "Label2", "Label3"],
  "data": [value1, value2, value3],
  "units": ["unit1", "unit2", "unit3"],
  "title": "Suggested chart title",
  "chartType": "bar" | "pie" | "line"
}

Rules:
- Only include data that has both a clear label and numerical value
- Exclude totals, summaries, or aggregate values
- Clean up label names (remove extra spaces, formatting characters)
- Convert all numbers to numeric values (remove commas, currency symbols)
- Suggest the most appropriate chart type for the data
- If no graphable data is found, return {"labels": [], "data": [], "units": []}

Example:
Text: "Sales by Region: North 1,500 USD, South 2,300 USD, East 1,800 USD"
Output: {
  "labels": ["North", "South", "East"],
  "data": [1500, 2300, 1800],
  "units": ["USD", "USD", "USD"],
  "title": "Sales by Region",
  "chartType": "bar"
}`;

            const completion = await this.openai.chat.completions.create({
                model: CONFIG.OPENAI_MODEL,
                messages: [
                    {
                        role: "system",
                        content: "You are a data extraction specialist. Extract structured data for chart creation. Always return valid JSON."
                    },
                    { role: "user", content: prompt }
                ],
                temperature: 0.1,
                max_tokens: 1000
            });

            const response = completion.choices[0].message.content || '{}';
            console.log('OpenAI extraction response:', response);

            const extractedData = JSON.parse(response);

            if (extractedData.labels && extractedData.data &&
                extractedData.labels.length > 0 && extractedData.data.length > 0 &&
                extractedData.labels.length === extractedData.data.length) {

                console.log('Successfully extracted data with AI:', extractedData);
                return extractedData;
            } else {
                console.log('AI extraction returned invalid data structure');
                return null;
            }

        } catch (error) {
            console.error('Error extracting graph data with AI:', error);
            return null;
        }
    }

    async correctSpelling(text: string): Promise<string> {
        if (!text || text.trim().length < 3) return text;
        const prompt = `Correct any spelling mistakes in the following text, but do not change the meaning or intent. Only return the corrected text, nothing else.\n\nText: ${text}`;
        const completion = await this.openai.chat.completions.create({
            model: CONFIG.OPENAI_MODEL,
            messages: [
                { role: "system", content: "You are a helpful assistant that corrects spelling mistakes in user queries." },
                { role: "user", content: prompt }
            ],
            temperature: 0.1
        });
        return completion.choices[0].message.content?.trim() || text;
    }

    async generateEmbedding(text: string): Promise<number[]> {
        try {
            const response = await this.openai.embeddings.create({
                model: CONFIG.OPENAI_EMBEDDING_MODEL,
                input: text,
                dimensions: CONFIG.OPENAI_EMBEDDING_DIMENSIONS
            });

            return response.data[0].embedding;
        } catch (error) {
            console.error('[OpenAIService] Error generating embedding:', error);
            throw error;
        }
    }

    async generateEmbeddings(texts: string[]): Promise<number[][]> {
        try {
            const response = await this.openai.embeddings.create({
                model: CONFIG.OPENAI_EMBEDDING_MODEL,
                input: texts,
                dimensions: CONFIG.OPENAI_EMBEDDING_DIMENSIONS
            });

            return response.data.map(item => item.embedding);
        } catch (error) {
            console.error('[OpenAIService] Error generating embeddings:', error);
            throw error;
        }
    }

    /**
     * Score the relevance of retrieved knowledge chunks to the user query
     * Returns a confidence score between 0 and 1
     */
    async scoreRelevance(query: string, knowledgeChunks: string[]): Promise<{
        confidence: number;
        relevantChunks: string[];
        reasoning: string;
    }> {
        if (!knowledgeChunks || knowledgeChunks.length === 0) {
            return {
                confidence: 0,
                relevantChunks: [],
                reasoning: "No knowledge chunks provided",
            };
        }

        try {
            const prompt = `You are a strict relevance evaluator. Your job is to determine if the retrieved knowledge base content is ACTUALLY relevant to answering the user's question.

CRITICAL RULES:
1. Only return HIGH confidence (>= 0.9) if the knowledge DIRECTLY answers the question
2. Return LOW confidence (< 0.7) if the knowledge is only tangentially related or requires inference
3. Return ZERO confidence if the knowledge is unrelated or insufficient

User Question: "${query}"

Retrieved Knowledge Base Content:
${knowledgeChunks.map((chunk, i) => `[Chunk ${i + 1}]\n${chunk}`).join("\n\n")}

Evaluate each chunk and return a JSON object with this exact structure:
{
  "confidence": 0.0-1.0,
  "relevantChunks": ["chunk content that is relevant", ...],
  "reasoning": "Brief explanation of why confidence is high/low"
}

Confidence scoring guide:
- 0.9-1.0: Knowledge directly answers the question with specific, relevant information
- 0.7-0.89: Knowledge is related but may require some inference or is partially relevant
- 0.5-0.69: Knowledge is only tangentially related or provides general context
- 0.0-0.49: Knowledge is not relevant or insufficient to answer the question

IMPORTANT: Be strict. Only include chunks that DIRECTLY help answer the question.`;

            const completion = await this.openai.chat.completions.create({
                model: CONFIG.OPENAI_MODEL,
                messages: [
                    {
                        role: "system",
                        content: "You are a strict relevance evaluator. You must be conservative and only mark content as relevant if it directly answers the question.",
                    },
                    { role: "user", content: prompt },
                ],
                temperature: 0.1, // Low temperature for consistent scoring
                response_format: { type: "json_object" },
            });

            const responseContent = completion.choices[0].message.content || '{}';
            const result = JSON.parse(responseContent);

            // Validate and normalize confidence score
            let confidence = typeof result.confidence === 'number' 
                ? Math.max(0, Math.min(1, result.confidence))
                : 0;

            // Ensure relevantChunks is an array
            const relevantChunks = Array.isArray(result.relevantChunks)
                ? result.relevantChunks
                : result.relevantChunks
                    ? [result.relevantChunks]
                    : [];

            const reasoning = result.reasoning || "No reasoning provided";

            console.log(`[OpenAIService] Relevance score: ${confidence.toFixed(3)}, Reasoning: ${reasoning}`);

            return {
                confidence,
                relevantChunks,
                reasoning,
            };
        } catch (error) {
            console.error('[OpenAIService] Error scoring relevance:', error);
            // Fallback: return low confidence if scoring fails
            return {
                confidence: 0.3,
                relevantChunks: [],
                reasoning: "Error during relevance scoring - defaulting to low confidence",
            };
        }
    }
}

