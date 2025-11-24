import { CONFIG } from '../config';
import { KnowledgeBaseReviewService } from './knowledgeBaseReviewService';


export class DailySummaryScheduler {
    private kbReviewService: KnowledgeBaseReviewService;
    private intervalId: NodeJS.Timeout | null = null;
    private lastSummaryDate: string = '';
    private pendingSummary: { summary: any; message: string } | null = null;

    constructor(kbReviewService: KnowledgeBaseReviewService) {
        this.kbReviewService = kbReviewService;
    }

    start(): void {
        if (!CONFIG.KNOWLEDGE_ANALYSIS_ENABLED) {
            console.log('[Scheduler] Knowledge analysis is disabled');
            return;
        }

        if (!CONFIG.KNOWLEDGE_REVIEW_GROUP_ID) {
            console.log('[Scheduler] Knowledge review group ID not configured');
            return;
        }

        console.log('[Scheduler] Starting daily summary scheduler');
        
        // Check every minute if it's time to send summary
        this.intervalId = setInterval(() => {
            this.checkAndSendSummary();
        }, 60000); // Check every minute

        // Also check immediately on startup
        this.checkAndSendSummary();
    }

    stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            console.log('[Scheduler] Daily summary scheduler stopped');
        }
    }

    private async checkAndSendSummary(): Promise<void> {
        try {
            const now = new Date();
            const currentDate = now.toISOString().split('T')[0];
            console.log('[Scheduler] Current date:', currentDate);
            console.log('[Scheduler] Daily analysis time:', CONFIG.DAILY_ANALYSIS_TIME);
            const [hours, minutes] = CONFIG.DAILY_ANALYSIS_TIME.split(':').map(Number);
            
            // Check if it's time to send summary and we haven't sent one today
            // Allow a 2-minute window to account for timing
            const timeMatch = now.getHours() === hours && 
                             now.getMinutes() >= minutes && 
                             now.getMinutes() < minutes + 2;
            
            if (timeMatch && this.lastSummaryDate !== currentDate) {
                console.log('[Scheduler] Time to send daily summary');
                await this.generateDailySummary();
                this.lastSummaryDate = currentDate;
            }
        } catch (error) {
            console.error('[Scheduler] Error checking summary schedule:', error);
        }
    }

    async generateDailySummary(): Promise<void> {
        try {
            const summary = await this.kbReviewService.generateDailySummary();
            const message = await this.kbReviewService.formatSummaryMessage(summary);

            // Store the summary for the app to send
            this.pendingSummary = { summary, message };
            
            console.log(`[Scheduler] Daily summary generated with ${summary.entries.length} entries`);
        } catch (error) {
            console.error('[Scheduler] Error generating daily summary:', error);
        }
    }

    getPendingSummary(): { summary: any; message: string } | null {
        const summary = this.pendingSummary;
        this.pendingSummary = null; // Clear after retrieval
        return summary;
    }

    // Manual trigger for testing
    async triggerSummaryNow(): Promise<void> {
        await this.generateDailySummary();
    }
}

