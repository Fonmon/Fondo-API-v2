import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FilesService } from './files.service';
import { PrismaService } from '../prisma/prisma.service';

const mockBlobSave = jest.fn().mockResolvedValue(undefined);
const mockBlobExists = jest.fn().mockResolvedValue([false]);
const mockBlobGetSignedUrl = jest.fn().mockResolvedValue(['https://signed.url/file']);
const mockFile = jest.fn().mockReturnValue({
  save: mockBlobSave,
  exists: mockBlobExists,
  getSignedUrl: mockBlobGetSignedUrl,
});
const mockBucket = jest.fn().mockReturnValue({ file: mockFile });

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: mockBucket })),
}));

describe('FilesService', () => {
  let service: FilesService;
  let prisma: any;

  const mockDbFile = {
    id: 1,
    display_name: 'document.pdf',
    type: 0,
    created_at: new Date(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockBlobExists.mockResolvedValue([false]);

    const mockPrisma = {
      fondo_api_file: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([mockDbFile]),
        create: jest.fn().mockResolvedValue(mockDbFile),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FilesService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'app.environment') return 'production';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<FilesService>(FilesService);
    prisma = module.get(PrismaService);
  });

  describe('saveFile', () => {
    it('should upload new file and insert into DB when blob did not exist', async () => {
      prisma.fondo_api_file.findUnique.mockResolvedValue(null);
      mockBlobExists.mockResolvedValue([false]);

      const result = await service.saveFile('document.pdf', 0, Buffer.from('content'), 'application/pdf');
      expect(mockBlobSave).toHaveBeenCalled();
      expect(prisma.fondo_api_file.create).toHaveBeenCalled();
      expect(result).toHaveProperty('id', 1);
      expect(result).toHaveProperty('type_display', 'proceeding');
    });

    it('should return existing DB record when display_name exists', async () => {
      prisma.fondo_api_file.findUnique.mockResolvedValue(mockDbFile);
      mockBlobExists.mockResolvedValue([false]);

      const result = await service.saveFile('document.pdf', 0, Buffer.from('content'), 'application/pdf');
      expect(prisma.fondo_api_file.create).not.toHaveBeenCalled();
      expect(result).toHaveProperty('id', 1);
    });

    it('should not upload but create DB record when blob exists but no DB record', async () => {
      prisma.fondo_api_file.findUnique.mockResolvedValue(null);
      mockBlobExists.mockResolvedValue([true]);

      const result = await service.saveFile('document.pdf', 0, Buffer.from('content'), 'application/pdf');
      expect(mockBlobSave).not.toHaveBeenCalled();
      expect(prisma.fondo_api_file.create).toHaveBeenCalled();
    });

    it('should use presentations type display', async () => {
      prisma.fondo_api_file.findUnique.mockResolvedValue(null);
      mockBlobExists.mockResolvedValue([false]);
      prisma.fondo_api_file.create.mockResolvedValue({ ...mockDbFile, type: 1 });

      const result = await service.saveFile('presentation.pdf', 1, Buffer.from('content'), 'application/pdf');
      expect(result.type_display).toBe('presentations');
    });

    it('should handle unknown type', async () => {
      prisma.fondo_api_file.findUnique.mockResolvedValue(null);
      mockBlobExists.mockResolvedValue([false]);
      prisma.fondo_api_file.create.mockResolvedValue({ ...mockDbFile, type: 99 });

      const result = await service.saveFile('other.pdf', 99, Buffer.from('content'), 'application/pdf');
      expect(result).toBeDefined();
    });
  });

  describe('getSignedUrl', () => {
    it('should return signed URL for existing file', async () => {
      prisma.fondo_api_file.findUnique.mockResolvedValue(mockDbFile);

      const result = await service.getSignedUrl(1);
      expect(result).toBe('https://signed.url/file');
    });

    it('should return null when file not found', async () => {
      prisma.fondo_api_file.findUnique.mockResolvedValue(null);

      const result = await service.getSignedUrl(999);
      expect(result).toBeNull();
    });

    it('should use presentations path for presentations type', async () => {
      prisma.fondo_api_file.findUnique.mockResolvedValue({ ...mockDbFile, type: 1 });

      await service.getSignedUrl(1);
      expect(mockFile).toHaveBeenCalledWith('presentations/document.pdf');
    });

    it('should fallback to proceeding for unknown file type', async () => {
      prisma.fondo_api_file.findUnique.mockResolvedValue({ ...mockDbFile, type: 99 });

      await service.getSignedUrl(1);
      expect(mockFile).toHaveBeenCalledWith('proceeding/document.pdf');
    });
  });

  describe('getFiles', () => {
    it('should get all files when type=-1', async () => {
      await service.getFiles(-1);
      expect(prisma.fondo_api_file.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('should filter by type when type != -1', async () => {
      await service.getFiles(0);
      expect(prisma.fondo_api_file.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { type: 0 } }),
      );
    });

    it('should return files with type_display', async () => {
      const result = await service.getFiles(-1);
      expect(result[0]).toHaveProperty('type_display', 'proceeding');
    });
  });
});
