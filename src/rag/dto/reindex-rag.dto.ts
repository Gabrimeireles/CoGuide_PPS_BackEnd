import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class ReindexRagDto {
  @IsBoolean()
  @IsOptional()
  resetCollection?: boolean;

  @IsString()
  @IsOptional()
  adminKey?: string;
}
