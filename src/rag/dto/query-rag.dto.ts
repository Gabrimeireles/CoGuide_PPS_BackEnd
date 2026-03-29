import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryRagDto {
  @IsString()
  query: string;

  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  k?: number;
}
