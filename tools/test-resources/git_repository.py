"""Git calls bound to an explicit worktree, isolated from an enclosing hook."""
import os
from pathlib import Path
import re
import subprocess


def repository_environment(root, inherited):
    names = subprocess.check_output(['git', 'rev-parse', '--local-env-vars'], cwd=root,
                                    env=inherited, stderr=subprocess.PIPE, timeout=30).decode().strip().splitlines()
    if (len(names) > 64 or any(not re.fullmatch(r'GIT_[A-Z0-9_]+', name) for name in names)
            or not {'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'} <= set(names)):
        raise ValueError('git-local-environment-unavailable')
    return {key: value for key, value in inherited.items()
            if key not in names and not re.fullmatch(r'GIT_CONFIG_(?:KEY|VALUE)_\d+', key)}


def git(repo, *args, inherited=None):
    root = Path(repo).resolve(strict=True)
    environment = repository_environment(root, os.environ if inherited is None else inherited)

    def run(*command):
        return subprocess.check_output(['git', *command], cwd=root, env=environment,
                                       stderr=subprocess.PIPE, timeout=30)

    if args and args[0] == 'init':
        if (root / '.git').exists() or (root / '.git').is_symlink():
            raise ValueError('git-init-existing-repository')
    elif Path(run('rev-parse', '--show-toplevel').decode().strip()).resolve(strict=True) != root:
        raise ValueError('git-worktree-root-mismatch')
    result = run(*args)
    if args and args[0] == 'init':
        if Path(run('rev-parse', '--show-toplevel').decode().strip()).resolve(strict=True) != root:
            raise ValueError('git-initialized-root-mismatch')
    return result
