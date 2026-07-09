import { githubGraphql, splitRepo, starRepo } from "./github.js";

const LIST_FRAGMENT = `
  id
  name
  slug
  description
  isPrivate
  createdAt
  updatedAt
  lastAddedAt
`;

const REPO_ITEM_FRAGMENT = `
  __typename
  ... on Repository {
    id
    name
    nameWithOwner
    description
    url
    primaryLanguage {
      name
    }
    stargazerCount
    forkCount
    isArchived
    isFork
    isPrivate
    pushedAt
    updatedAt
    viewerHasStarred
    repositoryTopics(first: 20) {
      nodes {
        topic {
          name
        }
      }
    }
  }
`;

const VIEWER_LISTS_QUERY = `
  query ViewerLists($after: String) {
    viewer {
      login
      lists(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ${LIST_FRAGMENT}
          items(first: 100) {
            totalCount
            nodes {
              __typename
            }
          }
        }
      }
    }
  }
`;

const LIST_ITEMS_QUERY = `
  query UserListItems($id: ID!, $after: String) {
    node(id: $id) {
      ... on UserList {
        items(first: 100, after: $after) {
          totalCount
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            ${REPO_ITEM_FRAGMENT}
          }
        }
      }
    }
  }
`;

const CREATE_LIST_MUTATION = `
  mutation CreateUserList($input: CreateUserListInput!) {
    createUserList(input: $input) {
      list {
        ${LIST_FRAGMENT}
      }
    }
  }
`;

const REPOSITORY_QUERY = `
  query RepositoryForList($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
      nameWithOwner
      viewerHasStarred
    }
  }
`;

const UPDATE_ITEM_LISTS_MUTATION = `
  mutation UpdateUserListsForItem($input: UpdateUserListsForItemInput!) {
    updateUserListsForItem(input: $input) {
      lists {
        ${LIST_FRAGMENT}
      }
    }
  }
`;

const DELETE_LIST_MUTATION = `
  mutation DeleteUserList($input: DeleteUserListInput!) {
    deleteUserList(input: $input) {
      user {
        login
      }
    }
  }
`;

export async function listGitHubLists(token, { includeItems = true } = {}) {
  const lists = [];
  let viewer = null;
  let after = null;
  do {
    const data = await githubGraphql(token, VIEWER_LISTS_QUERY, { after });
    viewer = data.viewer;
    const connection = data.viewer.lists;
    for (const node of connection.nodes || []) {
      const list = normalizeList(node);
      list.total_count = node.items?.totalCount || node.items?.nodes?.length || 0;
      if (includeItems && list.total_count > 0) {
        let page = await listItemsPage(token, node.id, null);
        list.repos.push(...normalizeRepoItems(page.nodes || []));
        while (page.pageInfo?.hasNextPage && page.pageInfo?.endCursor) {
          page = await listItemsPage(token, node.id, page.pageInfo.endCursor);
          list.repos.push(...normalizeRepoItems(page.nodes || []));
        }
      }
      lists.push(list);
    }
    after = connection.pageInfo?.endCursor || null;
    if (!connection.pageInfo?.hasNextPage) break;
  } while (after);
  return {
    viewer: viewer ? { login: viewer.login } : null,
    lists
  };
}

export async function createGitHubList(token, { name, description = "", isPrivate = false }) {
  const cleanName = cleanListName(name);
  const data = await githubGraphql(token, CREATE_LIST_MUTATION, {
    input: {
      name: cleanName,
      description: String(description || ""),
      isPrivate: Boolean(isPrivate)
    }
  });
  return normalizeList(data.createUserList.list);
}

export async function deleteGitHubList(token, name) {
  const state = await listGitHubLists(token, { includeItems: false });
  const list = findListInState(state, name);
  if (!list) {
    return {
      changed: false,
      name: cleanListName(name),
      list: null
    };
  }
  await githubGraphql(token, DELETE_LIST_MUTATION, {
    input: {
      listId: list.id
    }
  });
  return {
    changed: true,
    name: list.name,
    list
  };
}

export async function addRepoToGitHubList(token, listName, fullName, { create = false, star = true } = {}) {
  const { list, state } = await getTargetList(token, listName, { create });
  const repo = await getRepositoryForList(token, fullName);
  if (star && !repo.viewerHasStarred) await starRepo(token, repo.nameWithOwner);
  const existingListIds = listIdsForRepo(state.lists, repo.nameWithOwner);
  if (existingListIds.includes(list.id)) {
    return {
      changed: false,
      repo: repo.nameWithOwner,
      list,
      lists: state.lists.filter((item) => existingListIds.includes(item.id))
    };
  }
  const nextListIds = [...new Set([...existingListIds, list.id])];
  const lists = await updateRepoLists(token, repo.id, nextListIds);
  return {
    changed: true,
    repo: repo.nameWithOwner,
    list,
    lists
  };
}

export async function removeRepoFromGitHubList(token, listName, fullName) {
  const { list, state } = await getTargetList(token, listName, { create: false });
  const repo = await getRepositoryForList(token, fullName);
  const existingListIds = listIdsForRepo(state.lists, repo.nameWithOwner);
  if (!existingListIds.includes(list.id)) {
    return {
      changed: false,
      repo: repo.nameWithOwner,
      list,
      lists: state.lists.filter((item) => existingListIds.includes(item.id))
    };
  }
  const nextListIds = existingListIds.filter((id) => id !== list.id);
  const lists = await updateRepoLists(token, repo.id, nextListIds);
  return {
    changed: true,
    repo: repo.nameWithOwner,
    list,
    lists
  };
}

export async function findGitHubList(token, name) {
  const state = await listGitHubLists(token, { includeItems: true });
  return {
    state,
    list: findListInState(state, name)
  };
}

export async function getGitHubList(token, name) {
  const state = await listGitHubLists(token, { includeItems: false });
  const list = findListInState(state, name);
  if (!list) return null;
  if (list.total_count > 0) {
    let page = await listItemsPage(token, list.id, null);
    list.repos.push(...normalizeRepoItems(page.nodes || []));
    while (page.pageInfo?.hasNextPage && page.pageInfo?.endCursor) {
      page = await listItemsPage(token, list.id, page.pageInfo.endCursor);
      list.repos.push(...normalizeRepoItems(page.nodes || []));
    }
  }
  return list;
}

export function findListInState(state, name) {
  const clean = cleanListLookup(name);
  return (state.lists || []).find((list) =>
    list.name.toLowerCase() === clean || list.slug.toLowerCase() === clean
  ) || null;
}

function listIdsForRepo(lists, fullName) {
  return (lists || [])
    .filter((list) => (list.repos || []).some((repo) => repo.full_name.toLowerCase() === fullName.toLowerCase()))
    .map((list) => list.id);
}

async function getTargetList(token, listName, { create }) {
  let state = await listGitHubLists(token, { includeItems: true });
  let list = findListInState(state, listName);
  if (!list && create) {
    await createGitHubList(token, { name: listName });
    state = await listGitHubLists(token, { includeItems: true });
    list = findListInState(state, listName);
  }
  if (!list) throw new Error(`GitHub list "${listName}" does not exist. Run: gham lists create "${listName}"`);
  return { list, state };
}

async function getRepositoryForList(token, fullName) {
  const { owner, repo } = splitRepo(fullName);
  const data = await githubGraphql(token, REPOSITORY_QUERY, { owner, name: repo });
  if (!data.repository) throw new Error(`Repository "${fullName}" was not found or is not visible to this token.`);
  return data.repository;
}

async function updateRepoLists(token, itemId, listIds) {
  const data = await githubGraphql(token, UPDATE_ITEM_LISTS_MUTATION, {
    input: {
      itemId,
      listIds
    }
  });
  return (data.updateUserListsForItem.lists || []).map(normalizeList);
}

async function listItemsPage(token, listId, after) {
  const data = await githubGraphql(token, LIST_ITEMS_QUERY, { id: listId, after });
  return data.node?.items || { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
}

function normalizeList(list) {
  return {
    id: list.id,
    name: list.name,
    slug: list.slug,
    description: list.description || "",
    private: Boolean(list.isPrivate),
    created_at: list.createdAt || null,
    updated_at: list.updatedAt || null,
    last_added_at: list.lastAddedAt || null,
    repos: []
  };
}

function normalizeRepoItems(items) {
  return items
    .filter((item) => item?.__typename === "Repository")
    .map((repo) => ({
      id: repo.id,
      full_name: repo.nameWithOwner,
      name: repo.name,
      owner: repo.nameWithOwner?.split("/")[0] || "",
      description: repo.description || "",
      html_url: repo.url,
      language: repo.primaryLanguage?.name || "",
      topics: (repo.repositoryTopics?.nodes || []).map((item) => item.topic?.name).filter(Boolean),
      stargazers_count: repo.stargazerCount || 0,
      forks_count: repo.forkCount || 0,
      archived: Boolean(repo.isArchived),
      fork: Boolean(repo.isFork),
      private: Boolean(repo.isPrivate),
      pushed_at: repo.pushedAt || null,
      updated_at: repo.updatedAt || null,
      viewer_has_starred: Boolean(repo.viewerHasStarred)
    }));
}

function cleanListName(name) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("GitHub list name is required.");
  return clean;
}

function cleanListLookup(name) {
  return cleanListName(name).toLowerCase();
}
