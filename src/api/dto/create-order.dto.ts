import {
  IsString,
  IsEnum,
  IsNumber,
  IsPositive,
  Min,
  IsOptional,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import * as orderTypes from '../../domain/types/order.types';

export class CreateOrderDto {
  @ApiProperty({ example: 'BTC-USD', description: 'Trading instrument symbol' })
  @IsString()
  instrument: string;

  @ApiProperty({
    enum: ['BID', 'ASK'],
    example: 'BID',
    description: 'Order side',
  })
  @IsEnum(['BID', 'ASK'])
  side: orderTypes.OrderSide;

  @ApiPropertyOptional({
    enum: ['LIMIT', 'MARKET', 'IOC', 'FOK'],
    example: 'LIMIT',
    description: 'Order type (LIMIT, MARKET, IOC, FOK)',
  })
  @IsOptional()
  @IsEnum(['LIMIT', 'MARKET', 'IOC', 'FOK'])
  type?: orderTypes.OrderType;

  @ApiProperty({ example: 50000, description: 'Order price' })
  @IsNumber()
  @IsPositive()
  price: number;

  @ApiProperty({ example: 10, description: 'Order quantity' })
  @IsNumber()
  @IsPositive()
  @Min(1)
  quantity: number;
}
