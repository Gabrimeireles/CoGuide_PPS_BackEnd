import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

async function generateSwagger() {
  let app;

  try {
    if (!process.env.DB_URI) {
      if (process.env.CI === 'true') {
        process.env.DB_URI = 'mongodb://127.0.0.1:27017/swagger';
        console.log(
          `CI detectado. Usando DB_URI padrao para docs: ${process.env.DB_URI}`,
        );
      } else {
        throw new Error(
          'DB_URI nao definido. Defina DB_URI no ambiente para gerar o Swagger.',
        );
      }
    }

    app = await NestFactory.create(AppModule);

    const config = new DocumentBuilder()
      .setTitle('SLA callcenter API')
      .setDescription('Documentacao da Conecta SLA API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);

    const outputDir = join(
      __dirname,
      '..',
      process.env.SWAGGER_OUTPUT_DIR || 'swagger',
    );

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    writeFileSync(
      join(outputDir, 'swagger.json'),
      JSON.stringify(document, null, 2),
    );

    console.log('Swagger JSON gerado em:', join(outputDir, 'swagger.json'));
  } catch (error) {
    console.error('Erro ao gerar o Swagger JSON:', error);
    process.exit(1);
  } finally {
    if (app) {
      await app.close();
      console.log('Aplicacao NestJS fechada.');
    }
  }
}

generateSwagger();
