import {
  SearchClient,
  SearchIndexClient,
  AzureKeyCredential,
  SearchIndex,
  VectorSearch,
  VectorSearchAlgorithmConfiguration,
  HnswAlgorithmConfiguration,
} from "@azure/search-documents";
import { ManagedIdentityCredential } from "@azure/identity";
import { CONFIG } from "../config";
import { OpenAIService } from "./openaiService";

export interface KnowledgeDocument {
  id: string;
  content: string;
  question?: string;
  answer?: string;
  source: string;
  embedding?: number[];
  timestamp?: number;
  status?: string;
  metadata?: Record<string, any>;
}

export interface SearchResult {
  content: string;
  question?: string;
  answer?: string;
  source: string;
  score: number;
  metadata?: Record<string, any>;
}

export class AzureSearchService {
  private searchClient: SearchClient<KnowledgeDocument>;
  private indexClient: SearchIndexClient;
  private openaiService: OpenAIService;
  private indexName: string;
  private initialized: boolean = false;

  constructor(openaiService: OpenAIService) {
    this.openaiService = openaiService;
    this.indexName = CONFIG.AZURE_SEARCH_INDEX_NAME;

    if (!CONFIG.AZURE_SEARCH_ENDPOINT) {
      console.warn(
        "[AzureSearch] Endpoint not configured. Azure AI Search features will be disabled."
      );
      // Create dummy clients to prevent errors
      const dummyCredential = new AzureKeyCredential("dummy");
      this.searchClient = new SearchClient<KnowledgeDocument>(
        "",
        "",
        dummyCredential
      );
      this.indexClient = new SearchIndexClient("", dummyCredential);
      return;
    }

    // Initialize clients based on authentication method
    if (CONFIG.AZURE_SEARCH_USE_MANAGED_IDENTITY && CONFIG.MicrosoftAppId) {
      // Use Managed Identity (production)
      const credential = new ManagedIdentityCredential({
        clientId: CONFIG.MicrosoftAppId,
      });
      this.searchClient = new SearchClient<KnowledgeDocument>(
        CONFIG.AZURE_SEARCH_ENDPOINT,
        this.indexName,
        credential as any
      );
      this.indexClient = new SearchIndexClient(
        CONFIG.AZURE_SEARCH_ENDPOINT,
        credential as any
      );
    } else {
      // Use API Key (development)
      const adminKey = CONFIG.AZURE_SEARCH_ADMIN_KEY;
      if (!adminKey) {
        console.warn(
          "[AzureSearch] Admin key not configured. Azure AI Search features will be disabled."
        );
        const dummyCredential = new AzureKeyCredential("dummy");
        this.searchClient = new SearchClient<KnowledgeDocument>(
          "",
          "",
          dummyCredential
        );
        this.indexClient = new SearchIndexClient("", dummyCredential);
        return;
      }

      const credential = new AzureKeyCredential(adminKey);
      this.searchClient = new SearchClient<KnowledgeDocument>(
        CONFIG.AZURE_SEARCH_ENDPOINT,
        this.indexName,
        credential
      );
      this.indexClient = new SearchIndexClient(
        CONFIG.AZURE_SEARCH_ENDPOINT,
        credential
      );
    }
  }

  /**
   * Initialize the Azure AI Search index
   * Creates the index if it doesn't exist
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!CONFIG.AZURE_SEARCH_ENDPOINT) {
      console.warn(
        "[AzureSearch] Skipping initialization - endpoint not configured"
      );
      return;
    }

    try {
      // Check if index exists
      const indexExists = await this.indexExists();

      if (!indexExists) {
        console.log("[AzureSearch] Creating index:", this.indexName);
        await this.createIndex();
      } else {
        console.log("[AzureSearch] Index already exists:", this.indexName);
      }

      this.initialized = true;
      console.log("[AzureSearch] Initialized successfully");
    } catch (error) {
      console.error("[AzureSearch] Error initializing:", error);
      throw error;
    }
  }

  async search(query: string) {
    const searchResults = await this.searchClient.search(query, {
      top: 1,
    });
    for await (const result of searchResults.results) {
      console.log(result.document?.answer, "smith");
    }
  }

  /**
   * Check if the index exists
   */
  private async indexExists(): Promise<boolean> {
    try {
      await this.indexClient.getIndex(this.indexName);
      return true;
    } catch (error: any) {
      if (error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Create the search index with vector search configuration
   */
  private async createIndex(): Promise<void> {
    const indexDefinition: SearchIndex = {
      name: this.indexName,
      fields: [
        {
          name: "id",
          type: "Edm.String",
          key: true,
          filterable: true,
        },
        {
          name: "content",
          type: "Edm.String",
          searchable: true,
          analyzerName: "en.microsoft",
        },
        {
          name: "question",
          type: "Edm.String",
          searchable: true,
          analyzerName: "en.microsoft",
        },
        {
          name: "answer",
          type: "Edm.String",
          searchable: true,
          analyzerName: "en.microsoft",
        },
        {
          name: "source",
          type: "Edm.String",
          filterable: true,
        },
        {
          name: "embedding",
          type: "Collection(Edm.Single)",
          searchable: true,
          vectorSearchDimensions: CONFIG.OPENAI_EMBEDDING_DIMENSIONS,
          vectorSearchProfileName: "default-vector-profile",
        },
        {
          name: "timestamp",
          type: "Edm.Int64",
          filterable: true,
          sortable: true,
        },
        {
          name: "status",
          type: "Edm.String",
          filterable: true,
        },
      ],
      vectorSearch: {
        algorithms: [
          {
            name: "default-algorithm",
            kind: "hnsw",
            parameters: {
              metric: "cosine",
              m: 4,
              efConstruction: 400,
              efSearch: 500,
            },
          },
        ],
        profiles: [
          {
            name: "default-vector-profile",
            algorithmConfigurationName: "default-algorithm",
          },
        ],
      },
    };

    await this.indexClient.createIndex(indexDefinition);
    console.log("[AzureSearch] Index created successfully");
  }

  /**
   * Add or update a document in the index
   */
  async upsertDocument(doc: KnowledgeDocument): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Generate embedding if not provided
      if (!doc.embedding) {
        const textToEmbed =
          doc.question && doc.answer
            ? `${doc.question} ${doc.answer}`
            : doc.content;
        doc.embedding = await this.openaiService.generateEmbedding(textToEmbed);
      }

      await this.searchClient.mergeOrUploadDocuments([doc]);
      console.log(`[AzureSearch] Upserted document: ${doc.id}`);
    } catch (error) {
      console.error("[AzureSearch] Error upserting document:", error);
      throw error;
    }
  }

  /**
   * Add or update multiple documents in the index
   */
  async upsertDocuments(docs: KnowledgeDocument[]): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (docs.length === 0) return;

    try {
      // Generate embeddings for documents that don't have them
      const docsNeedingEmbeddings = docs.filter((doc) => !doc.embedding);
      if (docsNeedingEmbeddings.length > 0) {
        const textsToEmbed = docsNeedingEmbeddings.map((doc) =>
          doc.question && doc.answer
            ? `${doc.question} ${doc.answer}`
            : doc.content
        );
        const embeddings = await this.openaiService.generateEmbeddings(
          textsToEmbed
        );

        docsNeedingEmbeddings.forEach((doc, index) => {
          doc.embedding = embeddings[index];
        });
      }

      // Batch upload (Azure AI Search supports up to 1000 documents per batch)
      const batchSize = 1000;
      for (let i = 0; i < docs.length; i += batchSize) {
        const batch = docs.slice(i, i + batchSize);
        await this.searchClient.mergeOrUploadDocuments(batch);
        console.log(
          `[AzureSearch] Upserted batch ${Math.floor(i / batchSize) + 1} (${
            batch.length
          } documents)`
        );
      }

      console.log(
        `[AzureSearch] Successfully upserted ${docs.length} documents`
      );
    } catch (error) {
      console.error("[AzureSearch] Error upserting documents:", error);
      throw error;
    }
  }

  /**
   * Search for similar documents using vector similarity
   */
  async vectorSearch(
    query: string,
    topK: number = 5,
    threshold: number = 0.032
  ): Promise<SearchResult[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Generate embedding for the query
      const queryEmbedding = await this.openaiService.generateEmbedding(query);

      // Perform vector search
      const searchResults = await this.searchClient.search("*", {
        vectorSearchOptions: {
          queries: [
            {
              kind: "vector",
              vector: queryEmbedding,
              fields: ["embedding"] as any,
              kNearestNeighborsCount: topK,
            },
          ],
        },
        top: topK,
        includeTotalCount: true,
      });

      const results: SearchResult[] = [];
      for await (const result of searchResults.results) {
        if (result.score && result.score >= threshold) {
          const doc = result.document;
          results.push({
            content: doc.content || "",
            question: doc.question,
            answer: doc.answer,
            source: doc.source || "",
            score: result.score,
            metadata: doc.metadata,
          });
        }
      }

      console.log(
        `[AzureSearch] Found ${
          results.length
        } results for query: "${query.substring(0, 50)}..."`
      );
      return results;
    } catch (error) {
      console.error("[AzureSearch] Error performing vector search:", error);
      // Fallback to keyword search if vector search fails
      return await this.keywordSearch(query, topK);
    }
  }

  /**
   * Hybrid search combining vector and keyword search
   * Returns only results with similarity score >= threshold
   */
  async hybridSearch(
    query: string,
    topK: number = 3,
    threshold: number = 0.032
  ): Promise<SearchResult[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Generate embedding for the query
      const queryEmbedding = await this.openaiService.generateEmbedding(query);

      // Perform hybrid search (vector + keyword)
      // Request more results than needed to account for threshold filtering
      const searchResults = await this.searchClient.search(query, {
        vectorSearchOptions: {
          queries: [
            {
              kind: "vector",
              vector: queryEmbedding,
              fields: ["embedding"] as any,
              kNearestNeighborsCount: topK,
            },
          ],
        },
        top: topK,
        includeTotalCount: true,
      });

      const results: SearchResult[] = [];
      for await (const result of searchResults.results) {
        // IMPORTANT: Filter by similarity score threshold
        // Azure AI Search uses cosine similarity: 0.0 (no similarity) to 1.0 (identical)
        // Only include results that meet the minimum similarity threshold
        console.log("Score: " + result.score, " || vector return : " + result.document.question, " || user Query : " +  query)
        if (result.score && result.score >= threshold) {
          const doc = result.document;
          results.push({
            content: doc.content || "",
            question: doc.question,
            answer: doc.answer,
            source: doc.source || "",
            score: result.score,
            metadata: doc.metadata,
          });

          // Stop once we have enough high-quality results
          if (results.length >= topK) {
            break;
          }
        }
      }

      console.log(
        `[AzureSearch] Hybrid search found ${
          results.length
        } results (score >= ${threshold}) for query: "${query.substring(
          0,
          50
        )}..."`
      );

      // If no results meet threshold, return empty array (don't return low-quality matches)
      return results;
    } catch (error) {
      console.error("[AzureSearch] Error performing hybrid search:", error);
      // Fallback to vector search
      return await this.vectorSearch(query, topK, threshold);
    }
  }

  /**
   * Keyword-based search (fallback)
   */
  private async keywordSearch(
    query: string,
    topK: number = 5
  ): Promise<SearchResult[]> {
    try {
      const searchResults = await this.searchClient.search(query, {
        top: topK,
        includeTotalCount: true,
      });

      const results: SearchResult[] = [];
      for await (const result of searchResults.results) {
        const doc = result.document;
        results.push({
          content: doc.content || "",
          question: doc.question,
          answer: doc.answer,
          source: doc.source || "",
          score: result.score || 0,
          metadata: doc.metadata,
        });
      }

      return results;
    } catch (error) {
      console.error("[AzureSearch] Error performing keyword search:", error);
      return [];
    }
  }

  /**
   * Check for semantic duplicates
   * Returns similar documents with similarity score >= threshold
   */
  async findDuplicates(
    doc: KnowledgeDocument,
    threshold: number = 0.032
  ): Promise<KnowledgeDocument[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const textToEmbed =
        doc.question && doc.answer
          ? `${doc.question} ${doc.answer}`
          : doc.content;

      // Generate embedding if not provided
      if (!doc.embedding) {
        doc.embedding = await this.openaiService.generateEmbedding(textToEmbed);
      }

      // Search for similar documents
      const searchResults = await this.searchClient.search("*", {
        vectorSearchOptions: {
          queries: [
            {
              kind: "vector",
              vector: doc.embedding,
              fields: ["embedding"] as any,
              kNearestNeighborsCount: 10,
            },
          ],
        },
        top: 10,
        filter: doc.id ? `id ne '${doc.id}'` : undefined,
      });

      const duplicates: KnowledgeDocument[] = [];
      for await (const result of searchResults.results) {
        if (result.score && result.score >= threshold) {
          duplicates.push(result.document);
        }
      }

      console.log(
        `[AzureSearch] Found ${duplicates.length} potential duplicates for document: ${doc.id}`
      );
      return duplicates;
    } catch (error) {
      console.error("[AzureSearch] Error finding duplicates:", error);
      return [];
    }
  }

  /**
   * Delete a document from the index
   */
  async deleteDocument(id: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      await this.searchClient.deleteDocuments([
        { id, content: "", source: "" } as any,
      ]);
      console.log(`[AzureSearch] Deleted document: ${id}`);
    } catch (error) {
      console.error("[AzureSearch] Error deleting document:", error);
      throw error;
    }
  }

  /**
   * Get document count in the index
   */
  async getDocumentCount(): Promise<number> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const searchResults = await this.searchClient.search("*", {
        top: 0,
        includeTotalCount: true,
      });

      return searchResults.count || 0;
    } catch (error) {
      console.error("[AzureSearch] Error getting document count:", error);
      return 0;
    }
  }
}
