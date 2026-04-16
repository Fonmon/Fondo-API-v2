import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage } from '@google-cloud/storage';
import { PrismaService } from '../prisma/prisma.service';
import { FileType } from '../common/enums';

const FILE_TYPE_DISPLAY: Record<number, string> = {
  [FileType.PROCEEDING]: 'proceeding',
  [FileType.PRESENTATIONS]: 'presentations',
};

function buildFile(file: {
  id: number;
  display_name: string;
  type: number;
}) {
  return {
    id: file.id,
    display_name: file.display_name,
    type_display: FILE_TYPE_DISPLAY[file.type] ?? String(file.type),
  };
}

@Injectable()
export class FilesService {
  private readonly storage: Storage;
  private readonly bucketName = 'fonmon';

  /* istanbul ignore next */
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const environment = config.get<string>('app.environment');
    if (environment === 'test') {
      this.storage = new Storage({ projectId: 'test', apiEndpoint: 'http://localhost:9000' });
    } else {
      this.storage = new Storage();
    }
  }

  async saveFile(
    name: string,
    type: number,
    fileBuffer: Buffer,
    mimeType: string,
  ): Promise<{ id: number; display_name: string; type_display: string }> {
    const typeDisplay = FILE_TYPE_DISPLAY[type] ?? 'proceeding';
    const gcsPath = `${typeDisplay}/${name.toLowerCase()}`;
    const bucket = this.storage.bucket(this.bucketName);
    const blob = bucket.file(gcsPath);

    const [exists] = await blob.exists();
    if (!exists) {
      await blob.save(fileBuffer, {
        metadata: { contentType: mimeType },
      });
    }

    const existing = await this.prisma.fondo_api_file.findUnique({
      where: { display_name: name },
    });

    if (existing) {
      return buildFile(existing);
    }

    if (!exists) {
      const file = await this.prisma.fondo_api_file.create({
        data: {
          display_name: name,
          type,
          created_at: new Date(),
        },
      });
      return buildFile(file);
    }

    // blob existed but no DB record — create it
    const file = await this.prisma.fondo_api_file.create({
      data: {
        display_name: name,
        type,
        created_at: new Date(),
      },
    });
    return buildFile(file);
  }

  async getSignedUrl(id: number): Promise<string | null> {
    const file = await this.prisma.fondo_api_file.findUnique({
      where: { id },
    });
    if (!file) return null;

    const typeDisplay = FILE_TYPE_DISPLAY[file.type] ?? 'proceeding';
    const gcsPath = `${typeDisplay}/${file.display_name.toLowerCase()}`;
    const bucket = this.storage.bucket(this.bucketName);
    const blob = bucket.file(gcsPath);

    const [url] = await blob.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 5 * 60 * 1000, // 5 minutes
    });

    return url;
  }

  async getFiles(type: number): Promise<{ id: number; display_name: string; type_display: string }[]> {
    const where = type === -1 ? {} : { type };
    const files = await this.prisma.fondo_api_file.findMany({
      where,
      orderBy: { created_at: 'asc' },
    });
    return files.map(buildFile);
  }
}
