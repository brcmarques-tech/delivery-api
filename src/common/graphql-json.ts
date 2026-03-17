import { Scalar, CustomScalar } from '@nestjs/graphql';
import { Kind, ValueNode } from 'graphql';

@Scalar('JSONObject', () => Object)
export class GraphQLJSONObject implements CustomScalar<any, any> {
  description = 'JSON object scalar type';

  parseValue(value: any): any {
    return value;
  }

  serialize(value: any): any {
    return value;
  }

  parseLiteral(ast: ValueNode): any {
    if (ast.kind === Kind.OBJECT) {
      const obj: Record<string, any> = {};
      for (const field of ast.fields) {
        obj[field.name.value] = this.parseLiteral(field.value);
      }
      return obj;
    }
    if (ast.kind === Kind.STRING) return ast.value;
    if (ast.kind === Kind.INT) return parseInt(ast.value, 10);
    if (ast.kind === Kind.FLOAT) return parseFloat(ast.value);
    if (ast.kind === Kind.BOOLEAN) return ast.value;
    if (ast.kind === Kind.LIST) return ast.values.map((v) => this.parseLiteral(v));
    return null;
  }
}
