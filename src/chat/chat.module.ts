import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { GroqCloudService } from '../groq-cloud/groq-cloud.service';
import { ChatSchema } from './schemas/chat.schema';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    MongooseModule.forFeature([{ name: 'Chat', schema: ChatSchema }]),
    RagModule,
  ],
  controllers: [ChatController],
  providers: [ChatService, GroqCloudService],
})
export class ChatModule {}
