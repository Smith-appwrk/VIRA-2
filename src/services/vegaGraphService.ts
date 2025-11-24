import * as fs from 'fs/promises';
import * as path from 'path';
import { createCanvas } from 'canvas';

export class VegaGraphService {
    private outputDir: string | null = null;
    private isAzureEnvironment: boolean;
    private vega: any = null;
    private vegaLite: any = null;

    constructor() {
        this.isAzureEnvironment = process.env.WEBSITE_SITE_NAME ? true : false;
        console.log(`[VegaGraphService] Initialized for ${this.isAzureEnvironment ? 'Azure' : 'Local'} environment`);
    }

    async initializeVega(): Promise<void> {
        if (!this.vega || !this.vegaLite) {
            try {
                console.log('[VegaGraphService] Loading Vega modules...');
                this.vega = await import('vega');
                this.vegaLite = await import('vega-lite');

                if (!this.vega || !this.vegaLite) {
                    throw new Error('Failed to load Vega modules');
                }

                console.log('[VegaGraphService] Vega modules loaded successfully');
            } catch (error) {
                console.error('[VegaGraphService] Failed to load Vega modules:', error);
                throw error;
            }
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
                    console.log(`[VegaGraphService] Using output directory: ${dir}`);
                    return dir;
                }
            } catch (error: any) {
                console.log(`[VegaGraphService] Failed to create/use directory ${dir}: ${error.message}`);
            }
        }

        console.log('[VegaGraphService] No writable directory found, using in-memory processing');
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

    createVegaLiteSpec(data: any, chartType: string, title: string): any {
        const baseSpec = {
            $schema: "https://vega.github.io/schema/vega-lite/v5.json",
            title: {
                text: title,
                fontSize: 16,
                fontWeight: "bold",
                color: "#333333"
            },
            width: 600,
            height: 400,
            background: "white",
            config: {
                font: "Arial, sans-serif",
                axis: {
                    labelFontSize: 12,
                    titleFontSize: 14,
                    titleColor: "#333333",
                    labelColor: "#666666",
                    labelFont: "Arial, sans-serif",
                    titleFont: "Arial, sans-serif"
                },
                legend: {
                    labelFontSize: 12,
                    titleFontSize: 14,
                    labelFont: "Arial, sans-serif",
                    titleFont: "Arial, sans-serif"
                },
                title: {
                    font: "Arial, sans-serif"
                },
                text: {
                    font: "Arial, sans-serif"
                }
            }
        };

        const vegaData = this.prepareDataForVega(data);

        if (!vegaData || vegaData.length === 0) {
            console.warn('[VegaGraphService] No valid data for chart generation');
            return null;
        }

        switch (chartType.toLowerCase()) {
            case 'bar':
                return {
                    ...baseSpec,
                    data: { values: vegaData },
                    mark: {
                        type: "bar",
                        color: "#4285f4",
                        cornerRadius: 4
                    },
                    encoding: {
                        x: {
                            field: "category",
                            type: "nominal",
                            axis: { title: "Categories" }
                        },
                        y: {
                            field: "value",
                            type: "quantitative",
                            axis: { title: "Values" }
                        },
                        tooltip: [
                            { field: "category", type: "nominal" },
                            { field: "value", type: "quantitative" }
                        ]
                    }
                };

            case 'line':
                return {
                    ...baseSpec,
                    data: { values: vegaData },
                    mark: {
                        type: "line",
                        color: "#4285f4",
                        strokeWidth: 3,
                        point: {
                            filled: true,
                            size: 80,
                            color: "#4285f4"
                        }
                    },
                    encoding: {
                        x: {
                            field: "category",
                            type: "nominal",
                            axis: { title: "Categories" }
                        },
                        y: {
                            field: "value",
                            type: "quantitative",
                            axis: { title: "Values" }
                        },
                        tooltip: [
                            { field: "category", type: "nominal" },
                            { field: "value", type: "quantitative" }
                        ]
                    }
                };

            case 'pie':
            case 'doughnut':
                return {
                    ...baseSpec,
                    data: { values: vegaData },
                    mark: {
                        type: "arc",
                        innerRadius: chartType.toLowerCase() === 'doughnut' ? 50 : 0,
                        stroke: "white",
                        strokeWidth: 2
                    },
                    encoding: {
                        theta: {
                            field: "value",
                            type: "quantitative"
                        },
                        color: {
                            field: "category",
                            type: "nominal",
                            scale: {
                                range: ["#4285f4", "#34a853", "#fbbc04", "#ea4335", "#9aa0a6", "#ff6d01", "#46bdc6"]
                            }
                        },
                        tooltip: [
                            { field: "category", type: "nominal" },
                            { field: "value", type: "quantitative" }
                        ]
                    }
                };

            default:
                return this.createVegaLiteSpec(data, 'bar', title);
        }
    }

    prepareDataForVega(data: any): Array<{ category: string; value: number }> {
        if (Array.isArray(data)) {
            if (data.length > 0 && typeof data[0] === 'object' && 'category' in data[0]) {
                return data;
            }
            return data.map((value, index) => ({
                category: `Category ${index + 1}`,
                value: typeof value === 'number' ? value : parseFloat(value) || 0
            }));
        }

        if (data && typeof data === 'object') {
            if (data.labels && data.data) {
                return data.labels.map((label: string, index: number) => ({
                    category: String(label),
                    value: typeof data.data[index] === 'number' ? data.data[index] : parseFloat(data.data[index]) || 0
                }));
            }

            return Object.entries(data).map(([key, value]) => ({
                category: String(key),
                value: typeof value === 'number' ? value : parseFloat(value as string) || 0
            }));
        }

        console.warn('[VegaGraphService] Invalid data format, returning empty dataset');
        return [];
    }

    async generateGraph(data: any, chartType: string = 'bar', title: string = 'Chart'): Promise<string | Buffer> {
        try {
            console.log('[VegaGraphService] Generating graph:', { chartType, title });

            await this.initializeVega();

            const spec = this.createVegaLiteSpec(data, chartType, title);
            if (!spec) {
                throw new Error('Failed to create chart specification');
            }

            console.log('[VegaGraphService] Created Vega-Lite spec');

            const vegaSpec = this.vegaLite.compile(spec).spec;

            const view = new this.vega.View(this.vega.parse(vegaSpec))
                .renderer('none')
                .initialize();

            const canvas = await view.toCanvas();
            const pngBuffer = canvas.toBuffer();

            const outputDir = await this.ensureOutputDir();
            if (outputDir) {
                const filename = `chart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
                const filepath = path.join(outputDir, filename);

                try {
                    await fs.writeFile(filepath, pngBuffer);
                    console.log('[VegaGraphService] Chart saved to:', filepath);
                    this.cleanupOldFiles(outputDir);
                    return filepath;
                } catch (writeError) {
                    console.warn('[VegaGraphService] Failed to write to file, returning buffer:', writeError);
                }
            }

            console.log('[VegaGraphService] Returning PNG buffer');
            return pngBuffer;

        } catch (error) {
            console.error('[VegaGraphService] Error generating graph:', error);
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
                        console.log('[VegaGraphService] Cleaned up old file:', file);
                    } catch (deleteError) {
                        console.warn('[VegaGraphService] Failed to delete old file:', file);
                    }
                }
            }
        } catch (error) {
            console.warn('[VegaGraphService] Error during cleanup:', error);
        }
    }
}

