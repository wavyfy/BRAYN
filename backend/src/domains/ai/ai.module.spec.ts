import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AiModule } from './ai.module';
import { AiGatewayService } from './ai-gateway.service';
import { AI_PROVIDER } from './ai-provider.interface';
import { OpenAiAdapter } from './providers/openai/openai.adapter';
import { LoggingModule } from '../../common/logging/logging.module';

describe('AiModule', () => {
  async function compile() {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [() => ({ AI_MODEL: 'gpt-5.6-luna' })] }),
        LoggingModule,
        AiModule,
      ],
    }).compile();
  }

  it('resolves AI_PROVIDER to an OpenAiAdapter instance', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(AI_PROVIDER)).toBeInstanceOf(OpenAiAdapter);
  });

  it('resolves AiGatewayService through the module', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(AiGatewayService)).toBeInstanceOf(AiGatewayService);
  });
});
