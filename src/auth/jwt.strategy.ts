import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { User } from './schemas/user.schema';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectModel(User.name)
    private userModel: Model<User>,
    configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: {
    id: string;
    tokenVersion?: number;
    type?: string;
  }) {
    const { id, tokenVersion = 0, type = 'access' } = payload;

    if (type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }

    const user = await this.userModel.findById(id);

    if (!user) {
      throw new UnauthorizedException('Usuario nao encontrado');
    }

    if ((user.tokenVersion ?? 0) !== tokenVersion) {
      throw new UnauthorizedException('Token revogado');
    }

    return user;
  }
}
