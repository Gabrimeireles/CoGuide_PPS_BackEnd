import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({
  timestamps: true,
})
export class User extends Document {
  @Prop()
  name: string;

  @Prop({ unique: [true, 'Email must be unique'] })
  email: string;

  @Prop()
  password: string;

  @Prop({ default: 0 })
  tokenVersion: number;

  @Prop()
  refreshTokenHash?: string;

  @Prop()
  refreshTokenExpiresAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
