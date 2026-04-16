import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(() => {
    // Bypass the constructor (adapter + PrismaClient init requires a real DB).
    // onModuleInit is the only logic worth unit-testing here.
    service = Object.create(PrismaService.prototype) as PrismaService;
    (service as any).$connect = jest.fn().mockResolvedValue(undefined);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('calls $connect on module init', async () => {
    await service.onModuleInit();
    expect((service as any).$connect).toHaveBeenCalledTimes(1);
  });
});
