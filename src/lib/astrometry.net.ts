
'use server';

const API_URL = 'https://nova.astrometry.net/api';

export class AstrometryNet {
    private apiKey: string;
    private sessionKey: string | null = null;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    private async request(endpoint: string, body: any, isUpload: boolean = false) {
        const url = `${API_URL}/${endpoint}`;
        const options: RequestInit = {
            method: 'POST',
            ...(isUpload ? { body } : { body: `request-json=${encodeURIComponent(JSON.stringify(body))}` }),
            ...(!isUpload && { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
        };

        const response = await fetch(url, options);
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Astrometry.net API error on ${endpoint}: ${response.status} ${response.statusText} - ${errorText}`);
        }
        return response.json();
    }

    async login() {
        const data = await this.request('login', { apikey: this.apiKey });
        if (data.status === 'success') {
            this.sessionKey = data.session;
        } else {
            throw new Error(`Astrometry.net login failed: ${data.errormessage}`);
        }
    }

    async upload(fileBlob: Blob) {
        if (!this.sessionKey) {
            await this.login();
        }

        const formData = new FormData();
        formData.append('request-json', JSON.stringify({
             session: this.sessionKey,
             allow_commercial_use: 'd',
             allow_modifications: 'd',
             publicly_visible: 'y',
        }));
        formData.append('file', fileBlob, 'image.png');
        
        const data = await this.request('uploads', formData, true);

        if (data.status === 'success') {
            return data.subid;
        } else {
            throw new Error(`Astrometry.net upload failed: ${data.errormessage}`);
        }
    }

    async getJobStatus(submissionId: number) {
        const data = await fetch(`${API_URL}/submissions/${submissionId}`).then(res => res.json());
        if(data.job_calibrations && data.job_calibrations.length > 0) {
            const job = data.job_calibrations[0][1];
            const jobStatus = await fetch(`${API_URL}/jobs/${job}`).then(res => res.json());
            return { ...jobStatus, job };
        }
        return { status: "pending" };
    }
    
    async getAnnotations(jobId: number) {
        return await fetch(`${API_URL}/jobs/${jobId}/annotations/`).then(res => res.json());
    }
}
