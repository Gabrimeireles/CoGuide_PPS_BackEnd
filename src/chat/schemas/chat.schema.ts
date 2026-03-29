import { Schema, Document } from 'mongoose';

export const ChatSchema = new Schema(
  {
    userId: { type: String, required: true },
    messages: [
      {
        role: {
          type: String,
          enum: ['system', 'user', 'assistant'],
          required: true,
        },
        content: { type: String, required: true },
      },
    ],
    title: { type: String, required: false },
  },
  { timestamps: true },
);

export interface Chat extends Document {
  userId: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  title: string;
}
