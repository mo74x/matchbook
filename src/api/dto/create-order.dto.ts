/* eslint-disable @typescript-eslint/no-unsafe-call */
import { IsString, IsEnum, IsNumber, IsPositive, Min } from 'class-validator';
import * as orderTypes from '../../domain/types/order.types';

export class CreateOrderDto {
  @IsString()
  instrument: string;

  @IsEnum(['BID', 'ASK'])
  side: orderTypes.OrderSide;

  @IsNumber()
  @IsPositive()
  price: number;

  @IsNumber()
  @IsPositive()
  @Min(1) // Assuming integer quantities
  quantity: number;
}
