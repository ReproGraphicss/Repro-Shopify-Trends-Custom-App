/* eslint-disable eslint-comments/disable-enable-pair */
/* eslint-disable eslint-comments/no-unlimited-disable */
/* eslint-disable */
import type * as AdminTypes from './admin.types.d.ts';

export type TemporaryVariantSourceQueryVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  variantId: AdminTypes.Scalars['ID']['input'];
}>;


export type TemporaryVariantSourceQuery = { product?: AdminTypes.Maybe<(
    Pick<AdminTypes.Product, 'id' | 'title' | 'status'>
    & { metafield?: AdminTypes.Maybe<Pick<AdminTypes.Metafield, 'value'>>, featuredImage?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'id' | 'url' | 'altText'>>, featuredMedia?: AdminTypes.Maybe<Pick<AdminTypes.ExternalVideo, 'id'> | (
      Pick<AdminTypes.MediaImage, 'id'>
      & { image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url' | 'altText'>> }
    ) | Pick<AdminTypes.Model3d, 'id'> | Pick<AdminTypes.Video, 'id'>> }
  )>, productVariant?: AdminTypes.Maybe<(
    Pick<AdminTypes.ProductVariant, 'id' | 'sku'>
    & { image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'id' | 'url' | 'altText'>>, media: { nodes: Array<Pick<AdminTypes.ExternalVideo, 'id'> | (
        Pick<AdminTypes.MediaImage, 'id'>
        & { image?: AdminTypes.Maybe<Pick<AdminTypes.Image, 'url' | 'altText'>> }
      ) | Pick<AdminTypes.Model3d, 'id'> | Pick<AdminTypes.Video, 'id'>> }, selectedOptions: Array<Pick<AdminTypes.SelectedOption, 'name' | 'value'>> }
  )> };

export type UpdateTemporaryConfiguredVariantPriceMutationVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  variants: Array<AdminTypes.ProductVariantsBulkInput> | AdminTypes.ProductVariantsBulkInput;
}>;


export type UpdateTemporaryConfiguredVariantPriceMutation = { productVariantsBulkUpdate?: AdminTypes.Maybe<{ productVariants?: AdminTypes.Maybe<Array<Pick<AdminTypes.ProductVariant, 'id' | 'price'>>>, userErrors: Array<Pick<AdminTypes.ProductVariantsBulkUpdateUserError, 'field' | 'message'>> }> };

export type TemporaryConfiguredMasterVariantsQueryVariables = AdminTypes.Exact<{
  id: AdminTypes.Scalars['ID']['input'];
}>;


export type TemporaryConfiguredMasterVariantsQuery = { product?: AdminTypes.Maybe<(
    Pick<AdminTypes.Product, 'id'>
    & { variants: { nodes: Array<(
        Pick<AdminTypes.ProductVariant, 'id' | 'sku'>
        & { selectedOptions: Array<Pick<AdminTypes.SelectedOption, 'name' | 'value'>>, media: { nodes: Array<Pick<AdminTypes.ExternalVideo, 'id'> | Pick<AdminTypes.MediaImage, 'id'> | Pick<AdminTypes.Model3d, 'id'> | Pick<AdminTypes.Video, 'id'>> } }
      )> } }
  )> };

export type CreateMasterConfigurationVariantMutationVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  variants: Array<AdminTypes.ProductVariantsBulkInput> | AdminTypes.ProductVariantsBulkInput;
}>;


export type CreateMasterConfigurationVariantMutation = { productVariantsBulkCreate?: AdminTypes.Maybe<{ productVariants?: AdminTypes.Maybe<Array<Pick<AdminTypes.ProductVariant, 'id' | 'title' | 'price' | 'sku'>>>, userErrors: Array<Pick<AdminTypes.ProductVariantsBulkCreateUserError, 'field' | 'message'>> }> };

export type CreateTemporaryConfigurationProductMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.ProductSetInput;
  synchronous: AdminTypes.Scalars['Boolean']['input'];
}>;


export type CreateTemporaryConfigurationProductMutation = { productSet?: AdminTypes.Maybe<{ product?: AdminTypes.Maybe<(
      Pick<AdminTypes.Product, 'id' | 'title'>
      & { variants: { nodes: Array<Pick<AdminTypes.ProductVariant, 'id' | 'title' | 'price' | 'sku'>> } }
    )>, userErrors: Array<Pick<AdminTypes.ProductSetUserError, 'field' | 'message'>> }> };

export type DeleteExpiredMasterConfiguredVariantsMutationVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  variantIds: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type DeleteExpiredMasterConfiguredVariantsMutation = { productVariantsBulkDelete?: AdminTypes.Maybe<{ product?: AdminTypes.Maybe<Pick<AdminTypes.Product, 'id'>>, userErrors: Array<Pick<AdminTypes.ProductVariantsBulkDeleteUserError, 'field' | 'message'>> }> };

export type DeleteTemporaryConfigurationProductMutationVariables = AdminTypes.Exact<{
  input: AdminTypes.ProductDeleteInput;
}>;


export type DeleteTemporaryConfigurationProductMutation = { productDelete?: AdminTypes.Maybe<(
    Pick<AdminTypes.ProductDeletePayload, 'deletedProductId'>
    & { userErrors: Array<Pick<AdminTypes.UserError, 'field' | 'message'>> }
  )> };

export type DeleteExpiredConfiguredVariantsMutationVariables = AdminTypes.Exact<{
  productId: AdminTypes.Scalars['ID']['input'];
  variantIds: Array<AdminTypes.Scalars['ID']['input']> | AdminTypes.Scalars['ID']['input'];
}>;


export type DeleteExpiredConfiguredVariantsMutation = { productVariantsBulkDelete?: AdminTypes.Maybe<{ product?: AdminTypes.Maybe<Pick<AdminTypes.Product, 'id'>>, userErrors: Array<Pick<AdminTypes.ProductVariantsBulkDeleteUserError, 'field' | 'message'>> }> };

export type SyncLocationsQueryVariables = AdminTypes.Exact<{ [key: string]: never; }>;


export type SyncLocationsQuery = { locations: { nodes: Array<Pick<AdminTypes.Location, 'id' | 'name'>> } };

interface GeneratedQueryTypes {
  "#graphql\n      query TemporaryVariantSource($productId: ID!, $variantId: ID!) {\n        product(id: $productId) {\n          id title status\n          metafield(namespace: \"trends\", key: \"product_configuration\") { value }\n          featuredImage { id url altText }\n          featuredMedia {\n            id\n            ... on MediaImage { image { url altText } }\n          }\n        }\n        productVariant(id: $variantId) {\n          id sku\n          image { id url altText }\n          media(first: 1) {\n            nodes {\n              id\n              ... on MediaImage { image { url altText } }\n            }\n          }\n          selectedOptions { name value }\n        }\n      }\n    ": {return: TemporaryVariantSourceQuery, variables: TemporaryVariantSourceQueryVariables},
  "#graphql\n      query TemporaryConfiguredMasterVariants($id: ID!) {\n        product(id: $id) {\n          id\n          variants(first: 250) {\n            nodes {\n              id sku\n              selectedOptions { name value }\n              media(first: 1) { nodes { id } }\n            }\n          }\n        }\n      }\n    ": {return: TemporaryConfiguredMasterVariantsQuery, variables: TemporaryConfiguredMasterVariantsQueryVariables},
  "#graphql\n        query SyncLocations {\n          locations(first: 50, includeInactive: false) {\n            nodes { id name }\n          }\n        }\n      ": {return: SyncLocationsQuery, variables: SyncLocationsQueryVariables},
}

interface GeneratedMutationTypes {
  "#graphql\n      mutation UpdateTemporaryConfiguredVariantPrice(\n        $productId: ID!\n        $variants: [ProductVariantsBulkInput!]!\n      ) {\n        productVariantsBulkUpdate(productId: $productId, variants: $variants) {\n          productVariants { id price }\n          userErrors { field message }\n        }\n      }\n    ": {return: UpdateTemporaryConfiguredVariantPriceMutation, variables: UpdateTemporaryConfiguredVariantPriceMutationVariables},
  "#graphql\n      mutation CreateMasterConfigurationVariant(\n        $productId: ID!\n        $variants: [ProductVariantsBulkInput!]!\n      ) {\n        productVariantsBulkCreate(productId: $productId, variants: $variants) {\n          productVariants { id title price sku }\n          userErrors { field message }\n        }\n      }\n    ": {return: CreateMasterConfigurationVariantMutation, variables: CreateMasterConfigurationVariantMutationVariables},
  "#graphql\n      mutation CreateTemporaryConfigurationProduct($input: ProductSetInput!, $synchronous: Boolean!) {\n        productSet(input: $input, synchronous: $synchronous) {\n          product {\n            id title\n            variants(first: 1) { nodes { id title price sku } }\n          }\n          userErrors { field message }\n        }\n      }\n    ": {return: CreateTemporaryConfigurationProductMutation, variables: CreateTemporaryConfigurationProductMutationVariables},
  "#graphql\n              mutation DeleteExpiredMasterConfiguredVariants($productId: ID!, $variantIds: [ID!]!) {\n                productVariantsBulkDelete(productId: $productId, variantsIds: $variantIds) {\n                  product { id }\n                  userErrors { field message }\n                }\n              }\n            ": {return: DeleteExpiredMasterConfiguredVariantsMutation, variables: DeleteExpiredMasterConfiguredVariantsMutationVariables},
  "#graphql\n              mutation DeleteTemporaryConfigurationProduct($input: ProductDeleteInput!) {\n                productDelete(input: $input) {\n                  deletedProductId\n                  userErrors { field message }\n                }\n              }\n            ": {return: DeleteTemporaryConfigurationProductMutation, variables: DeleteTemporaryConfigurationProductMutationVariables},
  "#graphql\n            mutation DeleteExpiredConfiguredVariants($productId: ID!, $variantIds: [ID!]!) {\n              productVariantsBulkDelete(productId: $productId, variantsIds: $variantIds) {\n                product { id }\n                userErrors { field message }\n              }\n            }\n          ": {return: DeleteExpiredConfiguredVariantsMutation, variables: DeleteExpiredConfiguredVariantsMutationVariables},
}
declare module '@shopify/admin-api-client' {
  type InputMaybe<T> = AdminTypes.InputMaybe<T>;
  interface AdminQueries extends GeneratedQueryTypes {}
  interface AdminMutations extends GeneratedMutationTypes {}
}
