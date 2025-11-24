import * as fs from 'fs/promises';
import * as path from 'path';

export class DataForgeGraphService {
    private outputDir: string | null = null;
    private isAzureEnvironment: boolean;

    constructor() {
        this.isAzureEnvironment = process.env.WEBSITE_SITE_NAME ? true : false;
        console.log(`[DataForgeGraphService] Initialized for ${this.isAzureEnvironment ? 'Azure' : 'Local'} environment`);
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
                    console.log(`[DataForgeGraphService] Using output directory: ${dir}`);
                    return dir;
                }
            } catch (error: any) {
                console.log(`[DataForgeGraphService] Failed to create/use directory ${dir}: ${error.message}`);
            }
        }

        console.log('[DataForgeGraphService] No writable directory found, using in-memory processing');
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

    prepareDataForDataForge(data: any): Array<{ category: string; value: number }> {
        let chartData: Array<{ category: string; value: number }> = [];

        if (Array.isArray(data)) {
            if (data.length > 0 && typeof data[0] === 'object' && 'category' in data[0]) {
                chartData = data;
            } else {
                chartData = data.map((value, index) => ({
                    category: `Category ${index + 1}`,
                    value: typeof value === 'number' ? value : parseFloat(value) || 0
                }));
            }
        } else if (data && typeof data === 'object') {
            if (data.labels && data.data) {
                chartData = data.labels.map((label: string, index: number) => ({
                    category: String(label),
                    value: typeof data.data[index] === 'number' ? data.data[index] : parseFloat(data.data[index]) || 0
                }));
            } else {
                chartData = Object.entries(data).map(([key, value]) => ({
                    category: String(key),
                    value: typeof value === 'number' ? value : parseFloat(value as string) || 0
                }));
            }
        }

        console.log('[DataForgeGraphService] Prepared data:', chartData);
        return chartData;
    }

    async generateGraph(data: any, chartType: string = 'bar', title: string = 'Chart'): Promise<string> {
        try {
            console.log('[DataForgeGraphService] Generating graph:', { chartType, title });

            const chartData = this.prepareDataForDataForge(data);

            if (!chartData || chartData.length === 0) {
                throw new Error('No valid data provided for chart generation');
            }

            // Try to load data-forge-plot, but it may not be available (Electron dependency issues)
            let dataForge: any;
            try {
                dataForge = require('data-forge');
                require('data-forge-plot');
                require('@plotex/render-image');
            } catch (error: any) {
                console.warn('[DataForgeGraphService] Data-Forge not available, will use Vega fallback:', error.message);
                throw new Error('Data-Forge not available');
            }

            const dataFrame = new dataForge.DataFrame(chartData);

            const outputDir = await this.ensureOutputDir();
            const filename = `chart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
            const filepath = outputDir ? path.join(outputDir, filename) : filename;

            const plotDef = {
                chartType: chartType.toLowerCase() === 'pie' ? 'pie' :
                    chartType.toLowerCase() === 'line' ? 'line' : 'bar',
                width: 600,
                height: 400,
                x: 'category',
                y: 'value',
                title: {
                    text: title
                }
            };

            console.log('[DataForgeGraphService] Plot configuration:', plotDef);

            const renderPromise = dataFrame
                .plot(plotDef)
                .renderImage(filepath);

            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Chart rendering timeout after 30 seconds')), 30000);
            });

            await Promise.race([renderPromise, timeoutPromise]);
            console.log('[DataForgeGraphService] Chart rendered successfully to:', filepath);

            if (outputDir) {
                this.cleanupOldFiles(outputDir);
            }

            if (await fs.access(filepath).then(() => true).catch(() => false)) {
                return filepath;
            } else {
                throw new Error('Failed to generate chart file');
            }

        } catch (error) {
            console.error('[DataForgeGraphService] Error generating graph:', error);
            throw error;
        }
    }

    async cleanupOldFiles(directory: string): Promise<void> {
        try {
            const files = await fs.readdir(directory);
            const chartFiles = files.filter(file => file.startsWith('chart_') && file.endsWith('.png'));

            if (chartFiles.length > 10) {
                chartFiles.sort();
                const filesToDelete = chartFiles.slice(0, chartFiles.length - 10);

                for (const file of filesToDelete) {
                    try {
                        await fs.unlink(path.join(directory, file));
                        console.log('[DataForgeGraphService] Cleaned up old file:', file);
                    } catch (deleteError) {
                        console.warn('[DataForgeGraphService] Failed to delete old file:', file);
                    }
                }
            }
        } catch (error) {
            console.warn('[DataForgeGraphService] Error during cleanup:', error);
        }
    }
}

