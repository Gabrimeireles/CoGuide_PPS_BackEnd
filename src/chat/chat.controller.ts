import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { ChatService } from './chat.service';
import { GroqCloudService } from '../groq-cloud/groq-cloud.service';
import { CreateChatDto } from './dto/create-chat.dto';
import { User } from '../auth/schemas/user.schema';

type AuthenticatedRequest = Request & {
  user: User & { _id: string; id?: string };
};

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly groqCloudService: GroqCloudService,
  ) {}

  @UseGuards(AuthGuard())
  @Post()
  async createChat(
    @Req() req: AuthenticatedRequest,
    @Body() createChatDto: CreateChatDto,
  ) {
    // Prevent cross-user chat creation by forcing the authenticated user id.
    const userId = req.user.id || String(req.user._id);
    const firstMessageContent =
      createChatDto.messages?.[0]?.content || 'No prompt provided';
    const title =
      await this.groqCloudService.generateTitle(firstMessageContent);
    const chatDto = { ...createChatDto, userId, title };
    const chat = await this.chatService.createChat(chatDto);
    return chat;
  }

  @UseGuards(AuthGuard())
  @Get('user/me')
  async getUserChats(@Req() req: AuthenticatedRequest) {
    const currentUserId = req.user.id || String(req.user._id);
    return this.chatService.getChatsByUserId(currentUserId);
  }

  @UseGuards(AuthGuard())
  @Get(':id')
  async getChatById(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const currentUserId = req.user.id || String(req.user._id);
    const chat = await this.chatService.getUserChatById(id, currentUserId);

    if (!chat) {
      throw new NotFoundException('Chat não encontrado');
    }

    return chat;
  }

  @UseGuards(AuthGuard())
  @Post('send/:id?')
  async sendMessageToChat(
    @Param('id') id: string | null,
    @Body() body: { prompt: string },
    @Req() req: AuthenticatedRequest,
  ) {
    let chat;
    const userId = req.user.id || String(req.user._id);
    const systemMessage = await this.groqCloudService.getSystemMessage(body.prompt);
    if (id) {
      chat = await this.chatService.getChatById(id);

      if (!chat) {
        throw new NotFoundException('Chat não encontrado');
      }

      if (chat.userId !== userId) {
        throw new ForbiddenException('Você não tem acesso a este chat');
      }

      const conversationHistory = chat.messages
        .filter((msg) => msg.role !== 'system')
        .map((msg) => ({ role: msg.role, content: msg.content }));

      const response = await this.groqCloudService.getChatResponse(body.prompt, [
        { role: 'system', content: systemMessage },
        ...conversationHistory,
      ]);

      const nextMessages = [
        { role: 'system' as const, content: systemMessage },
        ...conversationHistory,
        { role: 'user' as const, content: body.prompt },
        { role: 'assistant' as const, content: response },
      ];

      chat = await this.chatService.updateChat(id, { messages: nextMessages });
    } else {
      const firstMessageContent = body.prompt;
      const title =
        await this.groqCloudService.generateTitle(firstMessageContent);
      const response = await this.groqCloudService.getChatResponse(
        firstMessageContent,
        [{ role: 'system', content: systemMessage }],
      );
      const createChatDto = {
        userId: userId,
        title,
        messages: [
          { role: 'system' as const, content: systemMessage },
          { role: 'user' as const, content: firstMessageContent },
          { role: 'assistant' as const, content: response },
        ],
      };
      chat = await this.chatService.createChat(createChatDto);
    }

    if (!chat) {
      throw new NotFoundException('Falha ao atualizar o chat');
    }

    return chat;
  }

  @UseGuards(AuthGuard())
  @Delete(':id')
  async deleteChat(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const userId = req.user.id || String(req.user._id);
    const deleted = await this.chatService.deleteUserChat(id, userId);

    if (!deleted) {
      throw new NotFoundException('Chat não encontrado');
    }

    return deleted;
  }
}
