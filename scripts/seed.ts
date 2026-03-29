import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { TiposAtendimentoService } from '../src/tipos-atendimento/tipos-atendimento.service';
import { seedTiposAtendimento } from '../src/seeds/tipos-atendimento.seed';
import { seedPassos } from 'src/seeds/passos.seed';
import { PassosService } from 'src/passos/passos.service';
import { SlaRulesService } from 'src/sla-rules/sla-rules.service';
import { seedSlaRules } from 'src/seeds/sla-rules.seed';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const shouldReset = process.argv.includes('--reset');

  const connection = app.get<Connection>(getConnectionToken());

  if (shouldReset) {
    console.log('[seed] Dropando banco de dados...');
    await connection.dropDatabase();
    console.log('[seed] Banco reiniciado.');
  }

  const tiposAtendimentoService = app.get(TiposAtendimentoService);
  const passosService = app.get(PassosService);
  const slaRulesService = app.get(SlaRulesService);

  await seedTiposAtendimento(tiposAtendimentoService);
  await seedPassos(passosService);
  await seedSlaRules(slaRulesService, tiposAtendimentoService, passosService);

  await app.close();
}

bootstrap();
