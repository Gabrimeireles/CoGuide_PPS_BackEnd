import { Injectable, UnauthorizedException } from '@nestjs/common';
import { User } from './schemas/user.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { SignUpDto } from './dto/signUp.dto';
import { LoginDto } from './dto/login.dto';

type AuthTokens = {
  token: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
};

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name)
    private userModel: Model<User>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async signUp(signUpDto: SignUpDto): Promise<AuthTokens> {
    const { name, email, password } = signUpDto;

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await this.userModel.create({
      name,
      email,
      password: hashedPassword,
    });

    return this.issueTokens(user);
  }

  async login(LoginDto: LoginDto): Promise<AuthTokens> {
    const { email, password } = LoginDto;

    const user = await this.userModel.findOne({ email });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.issueTokens(user);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = this.verifyRefreshToken(refreshToken);
    const user = await this.userModel.findById(payload.id);
    if (!user) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (payload.tokenVersion !== user.tokenVersion) {
      throw new UnauthorizedException('Refresh token revoked');
    }

    if (!user.refreshTokenHash || !user.refreshTokenExpiresAt) {
      throw new UnauthorizedException('Refresh token not found');
    }

    if (user.refreshTokenExpiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const matches = await bcrypt.compare(refreshToken, user.refreshTokenHash);
    if (!matches) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return this.issueTokens(user);
  }

  async logout(userId: string): Promise<{ success: true }> {
    await this.userModel.findByIdAndUpdate(userId, {
      $inc: { tokenVersion: 1 },
      $unset: { refreshTokenHash: '', refreshTokenExpiresAt: '' },
    });

    return { success: true };
  }

  private async issueTokens(user: User): Promise<AuthTokens> {
    const accessExpiresIn =
      this.configService.get<string>('JWT_EXPIRES') || '15m';
    const refreshExpiresIn =
      this.configService.get<string>('JWT_REFRESH_EXPIRES') || '7d';
    const refreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      this.configService.get<string>('JWT_SECRET') ||
      '';

    const accessPayload = {
      id: String(user._id),
      tokenVersion: user.tokenVersion ?? 0,
      type: 'access',
    };

    const refreshPayload = {
      id: String(user._id),
      tokenVersion: user.tokenVersion ?? 0,
      type: 'refresh',
    };

    const accessToken = this.jwtService.sign(accessPayload, {
      expiresIn: accessExpiresIn,
    });
    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: refreshSecret,
      expiresIn: refreshExpiresIn,
    });

    const refreshTokenHash = await bcrypt.hash(refreshToken, 10);
    const refreshTokenExpiresAt = this.calculateExpirationDate(refreshExpiresIn);

    await this.userModel.findByIdAndUpdate(user._id, {
      $set: { refreshTokenHash, refreshTokenExpiresAt },
    });

    return {
      token: accessToken,
      accessToken,
      refreshToken,
      expiresIn: String(accessExpiresIn),
    };
  }

  private verifyRefreshToken(refreshToken: string): {
    id: string;
    tokenVersion: number;
    type: string;
  } {
    const refreshSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      this.configService.get<string>('JWT_SECRET') ||
      '';

    try {
      const payload = this.jwtService.verify<{
        id: string;
        tokenVersion: number;
        type: string;
      }>(refreshToken, {
        secret: refreshSecret,
      });

      if (!payload || payload.type !== 'refresh') {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return payload;
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  private calculateExpirationDate(expiresIn: string): Date {
    const now = Date.now();
    const match = String(expiresIn).trim().match(/^(\d+)([smhd])$/i);

    if (!match) {
      return new Date(now + 7 * 24 * 60 * 60 * 1000);
    }

    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multiplierByUnit: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return new Date(now + value * multiplierByUnit[unit]);
  }
}
