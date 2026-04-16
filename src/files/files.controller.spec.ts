import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

describe('FilesController', () => {
  let controller: FilesController;
  let service: jest.Mocked<FilesService>;

  const mockFile = {
    id: 1,
    display_name: 'document.pdf',
    type_display: 'proceeding',
  };

  beforeEach(async () => {
    const mockService = {
      saveFile: jest.fn().mockResolvedValue(mockFile),
      getFiles: jest.fn().mockResolvedValue([mockFile]),
      getSignedUrl: jest.fn().mockResolvedValue('https://signed.url/file'),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [{ provide: FilesService, useValue: mockService }],
    }).compile();

    controller = module.get<FilesController>(FilesController);
    service = module.get(FilesService);
  });

  it('should save a file', async () => {
    const mockMulterFile = {
      originalname: 'document.pdf',
      buffer: Buffer.from('content'),
      mimetype: 'application/pdf',
    } as Express.Multer.File;

    const result = await controller.saveFile(mockMulterFile, '0');
    expect(result).toEqual(mockFile);
    expect(service.saveFile).toHaveBeenCalledWith('document.pdf', 0, mockMulterFile.buffer, 'application/pdf');
  });

  it('should use type 0 when type not provided', async () => {
    const mockMulterFile = {
      originalname: 'doc.pdf',
      buffer: Buffer.from(''),
      mimetype: 'application/pdf',
    } as Express.Multer.File;

    await controller.saveFile(mockMulterFile, undefined);
    expect(service.saveFile).toHaveBeenCalledWith('doc.pdf', 0, expect.any(Buffer), 'application/pdf');
  });

  it('should throw BadRequestException when no file', async () => {
    await expect(controller.saveFile(undefined as any, '0')).rejects.toThrow(BadRequestException);
  });

  it('should get files with type', async () => {
    await controller.getFiles('0');
    expect(service.getFiles).toHaveBeenCalledWith(0);
  });

  it('should get all files when type not provided', async () => {
    await controller.getFiles(undefined);
    expect(service.getFiles).toHaveBeenCalledWith(-1);
  });

  it('should get signed URL', async () => {
    const result = await controller.getSignedUrl('1');
    expect(result).toEqual({ url: 'https://signed.url/file' });
  });

  it('should throw NotFoundException when file not found', async () => {
    service.getSignedUrl.mockResolvedValue(null);
    await expect(controller.getSignedUrl('999')).rejects.toThrow(NotFoundException);
  });
});
