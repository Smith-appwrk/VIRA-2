import axios from 'axios';

export class ImageService {
    private maxRetries = 3;
    private retryDelay = 1000;

    async retryOperation<T>(operation: () => Promise<T>): Promise<T> {
        let lastError: Error | undefined;
        for (let i = 0; i < this.maxRetries; i++) {
            try {
                return await operation();
            } catch (error: any) {
                lastError = error;
                if (error.message?.includes('ECONNRESET') || error.message?.includes('timeout')) {
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay * (i + 1)));
                    continue;
                }
                throw error;
            }
        }
        throw lastError || new Error('Operation failed after retries');
    }

    async getToken(tokenFactory: (scope: string | string[], tenantId?: string) => Promise<string>): Promise<string> {
        return await this.retryOperation(async () => {
            try {
                console.log('[ImageService] Getting token...');
                const token = await tokenFactory('https://graph.microsoft.com/.default');
                console.log('[ImageService] Token obtained successfully');
                return token;
            } catch (err) {
                console.error('[ImageService] Error getting token:', err);
                throw err;
            }
        });
    }

    async processImage(imageUrl: string, tokenFactory: (scope: string | string[], tenantId?: string) => Promise<string>): Promise<string> {
        return await this.retryOperation(async () => {
            console.log('[ImageService] Processing image...', {
                imageUrl,
                urlDomain: new URL(imageUrl).hostname
            });

            const token = await this.getToken(tokenFactory);

            console.log('[ImageService] Downloading image from Teams...');
            try {
                const response = await axios.get(imageUrl, {
                    responseType: 'arraybuffer',
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    timeout: 5000
                });

                console.log('[ImageService] Image downloaded successfully', {
                    statusCode: response.status,
                    contentLength: response.data?.length
                });

                return Buffer.from(response.data).toString('base64');
            } catch (downloadError: any) {
                console.error('[ImageService] Error downloading image:', downloadError);
                throw downloadError;
            }
        });
    }
}

