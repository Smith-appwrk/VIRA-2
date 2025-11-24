import * as fs from 'fs/promises';
import * as path from 'path';
import { DataForgeGraphService } from './dataForgeGraphService';
import { VegaGraphService } from './vegaGraphService';

export class HybridGraphService {
    private outputDir: string | null = null;
    private isAzureEnvironment: boolean;
    private dataForgeService: DataForgeGraphService | null = null;
    private vegaService: VegaGraphService | null = null;

    constructor() {
        this.isAzureEnvironment = process.env.WEBSITE_SITE_NAME ? true : false;
        console.log(`[HybridGraphService] Initialized for ${this.isAzureEnvironment ? 'Azure' : 'Local'} environment`);
    }

    async initializeServices(): Promise<void> {
        // Skip Data-Forge initialization to avoid Electron dependency issues
        // Data-Forge requires Electron which has compatibility issues on ARM64
        // We'll use Vega as the primary chart generation method
        console.log('[HybridGraphService] Skipping Data-Forge (Electron dependency), using Vega as primary');
        
        // Uncomment below if you want to try Data-Forge (requires Electron installation)
        /*
        try {
            const { DataForgeGraphService } = await import('./dataForgeGraphService');
            this.dataForgeService = new DataForgeGraphService();
            console.log('[HybridGraphService] Data-Forge service initialized');
        } catch (error: any) {
            console.warn('[HybridGraphService] Failed to initialize Data-Forge service:', error.message);
        }
        */

        try {
            const { VegaGraphService } = await import('./vegaGraphService.js');
            this.vegaService = new VegaGraphService();
            console.log('[HybridGraphService] Vega service initialized as fallback');
        } catch (error: any) {
            console.error('[HybridGraphService] Failed to initialize Vega service:', error.message);
        }
    }

    async ensureOutputDir(): Promise<string | null> {
        if (this.outputDir && await this.isDirectoryWritable(this.outputDir)) {
            return this.outputDir;
        }

        const possibleDirs = [
            '/tmp/graphs',
            '/home/LogFiles/graphs',
            '/home/data/graphs',
            path.join(process.cwd(), 'temp', 'graphs'),
            path.join(require('os').tmpdir(), 'graphs')
        ];

        for (const dir of possibleDirs) {
            try {
                await fs.mkdir(dir, { recursive: true });
                if (await this.isDirectoryWritable(dir)) {
                    this.outputDir = dir;
                    console.log(`[HybridGraphService] Using output directory: ${dir}`);
                    return dir;
                }
            } catch (error: any) {
                console.log(`[HybridGraphService] Failed to create/use directory ${dir}: ${error.message}`);
            }
        }

        console.log('[HybridGraphService] No writable directory found, using in-memory processing');
        return null;
    }

    async isDirectoryWritable(dir: string): Promise<boolean> {
        try {
            const testFile = path.join(dir, 'test_write.tmp');
            await fs.writeFile(testFile, 'test');
            await fs.unlink(testFile);
            return true;
        } catch {
            return false;
        }
    }

    async generateGraph(data: any, chartType: string = 'bar', title: string = 'Chart'): Promise<string | Buffer> {
        try {
            console.log('[HybridGraphService] Generating graph:', { chartType, title });

            if (!this.vegaService) {
                await this.initializeServices();
            }

            // Use Vega as primary (Data-Forge requires Electron which has compatibility issues)
            if (this.vegaService) {
                return await this.vegaService.generateGraph(data, chartType, title);
            }

            // Fallback: Try Data-Forge if available (unlikely due to Electron dependency)
            if (this.dataForgeService) {
                try {
                    console.log('[HybridGraphService] Attempting Data-Forge chart generation...');
                    const dataForgePromise = this.dataForgeService.generateGraph(data, chartType, title);
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        setTimeout(() => reject(new Error('Data-Forge timeout')), 15000);
                    });
                    const result = await Promise.race([dataForgePromise, timeoutPromise]);
                    console.log('[HybridGraphService] Data-Forge chart generated successfully');
                    return result;
                } catch (error: any) {
                    console.warn('[HybridGraphService] Data-Forge failed:', error.message);
                }
            }

            throw new Error('No chart service available');

        } catch (error) {
            console.error('[HybridGraphService] All chart generation methods failed:', error);
            throw error;
        }
    }
}

